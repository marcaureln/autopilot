import { Octokit } from "@octokit/rest";
import { createAppAuth } from "@octokit/auth-app";
import type { AllowEntry } from "./allow.ts";
import type { Audit } from "./audit.ts";
import { checkRunState, issueOfBranch, type BotPull, type CheckState, type Statuses } from "./phase.ts";
import type { Repo } from "./repo.ts";
import type { FileChange } from "./risk.ts";
import type { Comment } from "./spec.ts";
import type { Change, CommentEdit } from "./trust.ts";

export type Issue = { number: number; title: string; body: string; labels: string[] };

export type Provenance = { body: Change; title?: Change; commentEdits: Map<number, CommentEdit> };

export type Comparison = { behind: number; ahead: number; changes: string[] };

export type LabelSpec = { name: string; color: string; description: string };

export type RepoGitHub = {
  listLabeledIssues(label: string, state: "open" | "closed"): Promise<Issue[]>;
  lastLabeled(issue: number, label: string): Promise<{ actor: string; at: string } | undefined>;
  listComments(issue: number): Promise<Comment[]>;
  postComment(issue: number, body: string): Promise<void>;
  deleteComment(id: number): Promise<void>;
  setLabels(issue: number, labels: string[]): Promise<void>;
  ensureLabels(labels: LabelSpec[]): Promise<void>;
  readFile(path: string): Promise<string | undefined>;
  minimizeOutdated(commentNodeId: string): Promise<void>;
  commentEditors(commentNodeId: string): Promise<string[]>;
  provenance(issue: number): Promise<Provenance>;
  // refresh: a new token, for a push that comes long after the clone.
  token(refresh?: boolean): Promise<string>;
  defaultBranch(): Promise<string>;
  lastUnlabeled(issue: number, label: string, actors: string[]): Promise<string | undefined>;
  userId(login: string): Promise<number>;
  botPulls(botLogin: string): Promise<BotPull[]>;
  pullFiles(pull: number): Promise<FileChange[]>;
  pullCommits(pull: number): Promise<string[]>;
  statuses(sha: string, botLogin: string): Promise<Statuses>;
  // The repo's own CI on sha (remote mode): the latest check run of each name, else a commit status with that context.
  ciStatuses(sha: string, names: string[]): Promise<Statuses>;
  // What a failed check run of the repo's CI says: its output, annotations and link.
  ciOutput(sha: string, name: string): Promise<string>;
  setStatus(sha: string, check: string, state: CheckState, description: string): Promise<void>;
  markPushed(sha: string, issue: number): Promise<void>;
  pushedFor(sha: string, botLogin: string): Promise<number | undefined>;
  // The changes of head since its merge base with base, as blob SHAs: equal changes mean equal content.
  compare(base: string, head: string): Promise<Comparison>;
  // Returns the new head. GitHub does the rebase, so the host's checkout never runs the branch's code.
  rebasePull(pull: number, expectedHead: string): Promise<string>;
  openPull(pull: { head: string; base: string; title: string; body: string }): Promise<number>;
  requestReview(pull: number, reviewers: string[]): Promise<void>;
  mergePull(pull: number, sha: string, title: string, message: string): Promise<void>;
};

export const STATUS_PREFIX = "autopilot/";

// A context that no check name in verify.required can produce.
const PUSHED_CONTEXT = "autopilot-host/pushed";
const PUSHED_DESCRIPTION = /^pushed by autopilot for #(\d+)$/;

const CHECK_STATES: readonly string[] = ["success", "failure", "error", "pending"] satisfies CheckState[];

function isCheckState(state: string): state is CheckState {
  return CHECK_STATES.includes(state);
}

function fileChange(file: { filename: string; status: string; previous_filename?: string; additions: number; deletions: number }): FileChange {
  const lines = { additions: file.additions, deletions: file.deletions };
  if (file.status === "renamed" && file.previous_filename) return { status: "renamed", path: file.filename, previousPath: file.previous_filename, ...lines };
  const status = file.status === "removed" ? "deleted" : file.status === "added" || file.status === "modified" ? file.status : "unknown";
  return { status, path: file.filename, ...lines };
}

export type GitHub = {
  appSlug(): Promise<string>;
  appLogin(): Promise<string>;
  findInstallation(entry: AllowEntry): Promise<number | undefined>;
  listRepos(installationId: number, owner: string): Promise<Repo[]>;
  repo(installationId: number, repo: Repo): RepoGitHub;
};

const quiet = { debug() {}, info() {}, warn() {}, error() {} };

function hasStatus(error: unknown, status: number): boolean {
  return typeof error === "object" && error !== null && "status" in error && error.status === status;
}

function hasToken(value: unknown): value is { token: string; expiresAt: string } {
  return typeof value === "object" && value !== null && "token" in value && typeof value.token === "string" && "expiresAt" in value && typeof value.expiresAt === "string";
}


// A 304 answer to a conditional request does not count against the rate limit, so an unchanged poll is free.
function cacheGetsByEtag(octokit: Octokit): Octokit {
  const cache = new Map<string, { etag: string; response: Awaited<ReturnType<Octokit["request"]>> }>();
  octokit.hook.wrap("request", async (request, options) => {
    if (options.method !== "GET") return request(options);
    const key = octokit.request.endpoint.parse(options).url;
    const cached = cache.get(key);
    if (cached) options.headers = { ...options.headers, "if-none-match": cached.etag };
    try {
      const response = await request(options);
      if (response.headers.etag) cache.set(key, { etag: response.headers.etag, response });
      return response;
    } catch (error) {
      if (cached && hasStatus(error, 304)) return cached.response;
      throw error;
    }
  });
  return octokit;
}

type Edits = { nodes: ({ editedAt: string; editor: { login: string } | null } | null)[] };

type CommentEdits = { node: { userContentEdits: Edits | null } | null };

type IssueProvenance = {
  repository: {
    issue: {
      author: { login: string } | null;
      createdAt: string;
      userContentEdits: Edits | null;
      timelineItems: { nodes: ({ createdAt?: string; actor?: { login: string } | null } | null)[] | null };
      comments: { nodes: ({ databaseId: number | null; userContentEdits: Edits | null } | null)[] | null };
    } | null;
  } | null;
};

function repoGitHub(octokit: Octokit, installationId: number, { owner, name: repo }: Repo, audit: Audit): RepoGitHub {
  const issueParams = (issue: number) => ({ owner, repo, issue_number: issue });
  return {
    async listLabeledIssues(label, state) {
      const issues = await octokit.paginate(octokit.issues.listForRepo, { owner, repo, labels: label, state, per_page: 100 });
      // The issues API also returns pull requests.
      return issues
        .filter((issue) => !issue.pull_request)
        .map((issue) => ({
          number: issue.number,
          title: issue.title,
          body: issue.body ?? "",
          labels: issue.labels.map((label) => (typeof label === "string" ? label : (label.name ?? ""))),
        }));
    },
    async lastLabeled(issue, label) {
      const events = await octokit.paginate(octokit.issues.listEvents, { ...issueParams(issue), per_page: 100 });
      const last = events.findLast((event) => event.event === "labeled" && "label" in event && event.label?.name === label);
      return last?.actor ? { actor: last.actor.login, at: last.created_at } : undefined;
    },
    async listComments(issue) {
      const comments = await octokit.paginate(octokit.issues.listComments, { ...issueParams(issue), per_page: 100 });
      return comments.map((comment) => ({
        id: comment.id,
        nodeId: comment.node_id,
        author: comment.user?.login ?? "",
        body: comment.body ?? "",
        createdAt: comment.created_at,
      }));
    },
    async postComment(issue, body) {
      await octokit.issues.createComment({ ...issueParams(issue), body });
    },
    async deleteComment(id) {
      await octokit.issues.deleteComment({ owner, repo, comment_id: id });
    },
    async setLabels(issue, labels) {
      await octokit.issues.setLabels({ ...issueParams(issue), labels });
    },
    async ensureLabels(labels) {
      const existing = new Set((await octokit.paginate(octokit.issues.listLabelsForRepo, { owner, repo, per_page: 100 })).map((label) => label.name));
      for (const label of labels.filter((label) => !existing.has(label.name))) {
        await octokit.issues.createLabel({ owner, repo, ...label });
      }
    },
    async readFile(path) {
      try {
        const { data } = await octokit.repos.getContent({ owner, repo, path });
        if (Array.isArray(data) || data.type !== "file" || !("content" in data)) return undefined;
        return Buffer.from(data.content, "base64").toString("utf8");
      } catch (error) {
        if (hasStatus(error, 404)) return undefined;
        throw error;
      }
    },
    async minimizeOutdated(commentNodeId) {
      await octokit.graphql(`mutation($id: ID!) { minimizeComment(input: { subjectId: $id, classifier: OUTDATED }) { clientMutationId } }`, {
        id: commentNodeId,
      });
    },
    async commentEditors(commentNodeId) {
      // GitHub lists the edits newest first.
      const { node } = await octokit.graphql<CommentEdits>(
        `query($id: ID!) { node(id: $id) { ... on IssueComment { userContentEdits(first: 100) { nodes { editedAt editor { login } } } } } }`,
        { id: commentNodeId },
      );
      return (node?.userContentEdits?.nodes ?? []).map((edit) => edit?.editor?.login ?? "");
    },
    async provenance(issue) {
      const { repository } = await octokit.graphql<IssueProvenance>(
        `query($owner: String!, $repo: String!, $number: Int!) {
          repository(owner: $owner, name: $repo) {
            issue(number: $number) {
              author { login }
              createdAt
              userContentEdits(first: 1) { nodes { editedAt editor { login } } }
              timelineItems(itemTypes: [RENAMED_TITLE_EVENT], last: 1) { nodes { ... on RenamedTitleEvent { createdAt actor { login } } } }
              comments(last: 100) { nodes { databaseId userContentEdits(first: 1) { nodes { editedAt editor { login } } } } }
            }
          }
        }`,
        { owner, repo, number: issue },
      );
      const data = repository?.issue;
      if (!data) throw new Error(`issue #${issue} not found`);
      const lastEdit = data.userContentEdits?.nodes[0];
      const rename = data.timelineItems.nodes?.[0];
      const commentEdits = new Map<number, CommentEdit>();
      for (const comment of data.comments.nodes ?? []) {
        const edit = comment?.userContentEdits?.nodes[0];
        if (comment?.databaseId) commentEdits.set(comment.databaseId, edit ? { edited: true, by: edit.editor?.login } : { edited: false });
      }
      return {
        body: lastEdit ? { by: lastEdit.editor?.login, at: lastEdit.editedAt } : { by: data.author?.login, at: data.createdAt },
        ...(rename?.createdAt && { title: { by: rename.actor?.login, at: rename.createdAt } }),
        commentEdits,
      };
    },
    async token(refresh = false) {
      const auth: unknown = await octokit.auth({ type: "installation", refresh });
      if (!hasToken(auth)) throw new Error("GitHub App auth returned no installation token");
      audit({ event: "token.minted", installation: installationId, repo: `${owner}/${repo}`, expires: auth.expiresAt });
      return auth.token;
    },
    async defaultBranch() {
      const { data } = await octokit.repos.get({ owner, repo });
      return data.default_branch;
    },
    async lastUnlabeled(issue, label, actors) {
      const events = await octokit.paginate(octokit.issues.listEvents, { ...issueParams(issue), per_page: 100 });
      return events.findLast((event) => event.event === "unlabeled" && "label" in event && event.label?.name === label && actors.includes(event.actor?.login ?? ""))?.created_at;
    },
    async userId(login) {
      const { data } = await octokit.users.getByUsername({ username: login });
      return data.id;
    },
    async botPulls(botLogin) {
      // Every open pull request, and the recently closed ones: a pull request closed long ago is history.
      const open = await octokit.paginate(octokit.pulls.list, { owner, repo, state: "open", per_page: 100 });
      const { data: closed } = await octokit.pulls.list({ owner, repo, state: "closed", sort: "updated", direction: "desc", per_page: 100 });
      return [...open, ...closed].flatMap((pull) => {
        const issue = issueOfBranch(pull.head.ref);
        if (pull.user?.login !== botLogin || issue === undefined || pull.head.repo?.full_name !== `${owner}/${repo}`) return [];
        const state = pull.merged_at ? "merged" : pull.state === "open" ? "open" : "closed";
        return [{ number: pull.number, issue, state, base: pull.base.ref, head: { ref: pull.head.ref, sha: pull.head.sha }, closedAt: pull.closed_at ?? undefined }];
      });
    },
    async pullFiles(pull) {
      const files = await octokit.paginate(octokit.pulls.listFiles, { owner, repo, pull_number: pull, per_page: 100 });
      return files.map(fileChange);
    },
    async pullCommits(pull) {
      const commits = await octokit.paginate(octokit.pulls.listCommits, { owner, repo, pull_number: pull, per_page: 100 });
      return commits.map((commit) => commit.sha);
    },
    async statuses(sha, botLogin) {
      // Anyone with write access can post a status with any context, so only the bot's own count.
      // GitHub lists the statuses newest first.
      const { data } = await octokit.repos.listCommitStatusesForRef({ owner, repo, ref: sha, per_page: 100 });
      const statuses: Statuses = {};
      for (const status of data) {
        const check = status.context.slice(STATUS_PREFIX.length);
        if (status.creator?.login !== botLogin || !status.context.startsWith(STATUS_PREFIX) || !isCheckState(status.state) || Object.hasOwn(statuses, check)) continue;
        statuses[check] = { state: status.state, description: status.description ?? "", at: status.updated_at };
      }
      return statuses;
    },
    async ciStatuses(sha, names) {
      const runs = await octokit.paginate(octokit.checks.listForRef, { owner, repo, ref: sha, filter: "latest", per_page: 100 });
      const { data } = await octokit.repos.listCommitStatusesForRef({ owner, repo, ref: sha, per_page: 100 });
      const statuses: Statuses = {};
      for (const name of names) {
        const run = runs.find((candidate) => candidate.name === name);
        if (run) {
          statuses[name] = { state: checkRunState(run), description: run.conclusion ?? run.status, at: run.completed_at ?? run.started_at ?? new Date().toISOString() };
          continue;
        }
        // GitHub lists the statuses newest first.
        const status = data.find((candidate) => candidate.context === name);
        if (status && isCheckState(status.state)) statuses[name] = { state: status.state, description: status.description ?? "", at: status.updated_at };
      }
      return statuses;
    },
    async ciOutput(sha, name) {
      const runs = await octokit.paginate(octokit.checks.listForRef, { owner, repo, ref: sha, check_name: name, filter: "latest", per_page: 100 });
      const run = runs[0];
      if (!run) return "";
      const annotations = await octokit.paginate(octokit.checks.listAnnotations, { owner, repo, check_run_id: run.id, per_page: 100 });
      return [
        run.output.title,
        run.output.summary,
        run.output.text,
        ...annotations.map((annotation) => `${annotation.path}:${annotation.start_line}: ${annotation.annotation_level}: ${annotation.message}`),
        run.details_url && `Logs: ${run.details_url}`,
      ]
        .filter((part) => typeof part === "string" && part.length > 0)
        .join("\n");
    },
    async setStatus(sha, check, state, description) {
      // GitHub rejects a description longer than 140 characters.
      await octokit.repos.createCommitStatus({ owner, repo, sha, state, context: `${STATUS_PREFIX}${check}`, description: description.slice(0, 140) });
    },
    async markPushed(sha, issue) {
      await octokit.repos.createCommitStatus({ owner, repo, sha, state: "success", context: PUSHED_CONTEXT, description: `pushed by autopilot for #${issue}` });
    },
    async pushedFor(sha, botLogin) {
      const { data } = await octokit.repos.listCommitStatusesForRef({ owner, repo, ref: sha, per_page: 100 });
      const mark = data.find((status) => status.context === PUSHED_CONTEXT && status.creator?.login === botLogin);
      const issue = PUSHED_DESCRIPTION.exec(mark?.description ?? "")?.[1];
      return issue === undefined ? undefined : Number(issue);
    },
    async compare(base, head) {
      const { data } = await octokit.repos.compareCommitsWithBasehead({ owner, repo, basehead: `${base}...${head}`, per_page: 1 });
      const changes = (data.files ?? []).map((file) => `${file.status} ${file.previous_filename ?? ""} ${file.filename} ${file.sha ?? ""}`).sort();
      return { behind: data.behind_by, ahead: data.ahead_by, changes };
    },
    async rebasePull(pull, expectedHead) {
      const { data } = await octokit.pulls.get({ owner, repo, pull_number: pull });
      await octokit.graphql(
        `mutation($id: ID!, $head: GitObjectID!) { updatePullRequestBranch(input: { pullRequestId: $id, expectedHeadOid: $head, updateMethod: REBASE }) { clientMutationId } }`,
        { id: data.node_id, head: expectedHead },
      );
      // GitHub answers before the rebase is done, with the old head.
      for (let attempt = 0; attempt < 30; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 2000));
        const { data: now } = await octokit.pulls.get({ owner, repo, pull_number: pull });
        if (now.head.sha !== expectedHead) return now.head.sha;
      }
      throw new Error(`the head of #${pull} is still ${expectedHead.slice(0, 7)} one minute after the rebase`);
    },
    async openPull({ head, base, title, body }) {
      const { data } = await octokit.pulls.create({ owner, repo, head, base, title, body });
      return data.number;
    },
    async requestReview(pull, reviewers) {
      await octokit.pulls.requestReviewers({ owner, repo, pull_number: pull, reviewers });
    },
    async mergePull(pull, sha, title, message) {
      await octokit.pulls.merge({ owner, repo, pull_number: pull, sha, merge_method: "squash", commit_title: title, commit_message: message });
    },
  };
}

export function createGitHub(auth: { appId: number; privateKey: string }, audit: Audit): GitHub {
  const app = new Octokit({ authStrategy: createAppAuth, auth, log: quiet });
  const clients = new Map<number, Octokit>();
  const installationIds = new Map<string, number>();
  let slug: string | undefined;

  function asInstallation(installationId: number): Octokit {
    let octokit = clients.get(installationId);
    if (!octokit) {
      octokit = cacheGetsByEtag(new Octokit({ authStrategy: createAppAuth, auth: { ...auth, installationId }, log: quiet }));
      clients.set(installationId, octokit);
    }
    return octokit;
  }

  async function appSlug(): Promise<string> {
    if (!slug) {
      const { data } = await app.apps.getAuthenticated();
      if (!data?.slug) throw new Error("GitHub App has no slug");
      slug = data.slug;
    }
    return slug;
  }

  return {
    appSlug,
    appLogin: async () => `${await appSlug()}[bot]`,
    async findInstallation(entry) {
      const key = entry.repo ? `${entry.owner}/${entry.repo}` : entry.owner;
      const known = installationIds.get(key);
      if (known !== undefined) return known;
      try {
        const { data } = entry.repo
          ? await app.apps.getRepoInstallation({ owner: entry.owner, repo: entry.repo })
          : await app.apps.getUserInstallation({ username: entry.owner });
        installationIds.set(key, data.id);
        return data.id;
      } catch (error) {
        if (hasStatus(error, 404)) return undefined;
        throw error;
      }
    },
    async listRepos(installationId, owner) {
      const octokit = asInstallation(installationId);
      const repos = await octokit.paginate(octokit.apps.listReposAccessibleToInstallation, { per_page: 100 });
      return repos.filter((repo) => repo.owner.login === owner).map((repo) => ({ owner: repo.owner.login, name: repo.name }));
    },
    repo: (installationId, repo) => repoGitHub(asInstallation(installationId), installationId, repo, audit),
  };
}
