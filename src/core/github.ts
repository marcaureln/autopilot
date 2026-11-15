import { Octokit } from "@octokit/rest";
import { createAppAuth } from "@octokit/auth-app";
import type { AllowEntry } from "./allow.ts";
import type { Repo } from "./repo.ts";
import type { Comment } from "./spec.ts";
import type { Change, CommentEdit } from "./trust.ts";

export type Issue = { number: number; title: string; body: string; labels: string[] };

export type Provenance = { body: Change; title?: Change; commentEdits: Map<number, CommentEdit> };

export type LabelSpec = { name: string; color: string; description: string };

export type RepoGitHub = {
  listLabeledIssues(label: string): Promise<Issue[]>;
  lastLabeled(issue: number, label: string): Promise<{ actor: string; at: string } | undefined>;
  listComments(issue: number): Promise<Comment[]>;
  postComment(issue: number, body: string): Promise<void>;
  setLabels(issue: number, labels: string[]): Promise<void>;
  ensureLabels(labels: LabelSpec[]): Promise<void>;
  readFile(path: string): Promise<string | undefined>;
  minimizeOutdated(commentNodeId: string): Promise<void>;
  commentEditors(commentNodeId: string): Promise<string[]>;
  provenance(issue: number): Promise<Provenance>;
  token(): Promise<string>;
};

export type GitHub = {
  appLogin(): Promise<string>;
  findInstallation(entry: AllowEntry): Promise<number | undefined>;
  listRepos(installationId: number, owner: string): Promise<Repo[]>;
  repo(installationId: number, repo: Repo): RepoGitHub;
};

const quiet = { debug() {}, info() {}, warn() {}, error() {} };

function hasStatus(error: unknown, status: number): boolean {
  return typeof error === "object" && error !== null && "status" in error && error.status === status;
}

function hasToken(value: unknown): value is { token: string } {
  return typeof value === "object" && value !== null && "token" in value && typeof value.token === "string";
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

function repoGitHub(octokit: Octokit, { owner, name: repo }: Repo): RepoGitHub {
  const issueParams = (issue: number) => ({ owner, repo, issue_number: issue });
  return {
    async listLabeledIssues(label) {
      const issues = await octokit.paginate(octokit.issues.listForRepo, { owner, repo, labels: label, state: "open", per_page: 100 });
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
    async token() {
      const auth: unknown = await octokit.auth({ type: "installation" });
      if (!hasToken(auth)) throw new Error("GitHub App auth returned no installation token");
      return auth.token;
    },
  };
}

export function createGitHub(auth: { appId: number; privateKey: string }): GitHub {
  const app = new Octokit({ authStrategy: createAppAuth, auth, log: quiet });
  const clients = new Map<number, Octokit>();
  const installationIds = new Map<string, number>();
  let login: string | undefined;

  function asInstallation(installationId: number): Octokit {
    let octokit = clients.get(installationId);
    if (!octokit) {
      octokit = cacheGetsByEtag(new Octokit({ authStrategy: createAppAuth, auth: { ...auth, installationId }, log: quiet }));
      clients.set(installationId, octokit);
    }
    return octokit;
  }

  return {
    async appLogin() {
      if (!login) {
        const { data } = await app.apps.getAuthenticated();
        if (!data?.slug) throw new Error("GitHub App has no slug");
        login = `${data.slug}[bot]`;
      }
      return login;
    },
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
    repo: (installationId, repo) => repoGitHub(asInstallation(installationId), repo),
  };
}
