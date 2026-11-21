// An in-memory GitHub for the tests of the issue flow in run.ts, with fakes of the planner, the
// builder and the checks. Tests read back what a user sees on GitHub: labels, comments, statuses,
// pull requests, merges and review requests. This is not a *.test.ts file, so `node --test` skips it.
import { claimComment } from "../core/claim.ts";
import { CONFIG_PATH } from "../core/config.ts";
import type { BuildJob, Built } from "../core/builder.ts";
import type { CheckResult, ChecksJob } from "../core/checks.ts";
import { RateLimited, type FoundIssue, type GitHub, type Issue, type OnboardingPull, type Provenance, type RepoGitHub } from "../core/github.ts";
import type { Host } from "../core/host.ts";
import type { OnboardJob, Onboarded } from "../core/onboarder.ts";
import { issueOfBranch, type BotPull, type CheckState, type Statuses } from "../core/phase.ts";
import type { PlannerJob } from "../core/planner.ts";
import type { PlannerResult } from "../core/planner-result.ts";
import { ONBOARDING_BRANCH, type Repo } from "../core/repo.ts";
import type { FileChange } from "../core/risk.ts";
import type { Comment } from "../core/spec.ts";
import type { CommentEdit } from "../core/trust.ts";
import { TRIGGER_LABEL } from "../core/state.ts";
import { loopState, pollOnce, drain, type Loop, type LoopState } from "./run.ts";

export const BOT = "autopilot[bot]";
export const OWNER = "owner";
export const HOST_NAME = "pi";
export const CLAIM_ID = "c1a1m0000001";
const REPO: Repo = { owner: "owner", name: "app" };
const FULL_QUOTA = { limit: 5000, remaining: 5000, resetAt: new Date("2026-01-01T01:00:00Z") };

type FakeIssue = { number: number; title: string; body: string; labels: string[]; open: boolean; author: string; createdAt: string; labeledBy: string; labeledAt: string };

// `editors` is newest first. Once a comment is edited, GitHub also lists its author as the oldest entry.
type FakeComment = Comment & { issue: number; editors: string[]; minimized: boolean };

type FakePull = BotPull & { files: FileChange[]; title: string; body: string };

export type FakeConfig = Record<string, unknown>;

export class FakeRepoGitHub implements RepoGitHub {
  config: FakeConfig | undefined;
  empty = false;
  issues = new Map<number, FakeIssue>();
  comments: FakeComment[] = [];
  pulls: FakePull[] = [];
  branches = new Map<string, string[]>();
  pushed = new Map<string, number>();
  statusesBySha = new Map<string, Statuses>();
  ciRuns = new Map<string, Statuses>();
  merges: { pull: number; sha: string; title: string; message: string }[] = [];
  reviewRequests: { pull: number; reviewers: string[] }[] = [];
  // Heads that the default branch moved past. GitHub cannot rebase any of them.
  behind = new Set<string>();
  // Runs when the host asks GitHub for a rebase, for example a person's push.
  onRebase: () => void = () => undefined;
  private clock = Date.parse("2026-01-01T00:00:00Z");
  private nextId = 1;
  private nextIssue = 1;

  constructor(config: FakeConfig | undefined) {
    this.config = config;
  }

  now(): string {
    this.clock += 1000;
    return new Date(this.clock).toISOString();
  }

  // --- Test-side setup and read-back

  openIssue({ title, labeledBy, claimed = true }: { title: string; labeledBy: string; claimed?: boolean }): number {
    const number = this.nextIssue++;
    const createdAt = this.now();
    this.issues.set(number, { number, title, body: `${title} body`, labels: [TRIGGER_LABEL], open: true, author: OWNER, createdAt, labeledBy, labeledAt: this.now() });
    if (claimed) this.addComment(number, BOT, claimComment(CLAIM_ID));
    return number;
  }

  addComment(issue: number, author: string, body: string): Comment {
    const comment: FakeComment = { id: this.nextId++, nodeId: `node-${this.nextId}`, author, body, createdAt: this.now(), issue, editors: [], minimized: false };
    this.comments.push(comment);
    return comment;
  }

  editComment(id: number, by: string, body: string): void {
    const comment = this.comments.find((candidate) => candidate.id === id);
    if (!comment) throw new Error(`no comment ${id}`);
    comment.body = body;
    comment.editors = comment.editors.length === 0 ? [by, comment.author] : [by, ...comment.editors];
  }

  // Ticks the Approve box of the newest spec comment, as `by`.
  tick(issue: number, by: string): void {
    const spec = this.comments.findLast((comment) => comment.issue === issue && comment.author === BOT && comment.body.startsWith("<!-- autopilot:spec"));
    if (!spec) throw new Error(`no spec comment on #${issue}`);
    this.editComment(spec.id, by, spec.body.replace("- [ ] Approve and build", "- [x] Approve and build"));
  }

  // A commit on a branch that the host did not push: anyone with write access can do this.
  pushCommit(branch: string, sha: string, issue?: number): void {
    this.branches.set(branch, [...(this.branches.get(branch) ?? []), sha]);
    for (const pull of this.pulls) if (pull.state === "open" && pull.head.ref === branch) pull.head.sha = sha;
    if (issue !== undefined) this.pushed.set(sha, issue);
  }

  openPullFor(branch: string, base = "main", files?: FileChange[]): number {
    const commits = this.branches.get(branch) ?? [];
    const number = this.pulls.length + 1;
    this.pulls.push({ number, issue: issueOfBranch(branch) ?? 0, state: "open", base, head: { ref: branch, sha: commits.at(-1) ?? "" }, closedAt: undefined, files: files ?? DEFAULT_FILES, title: "", body: "" });
    return number;
  }

  finishPull(pull: number, state: "merged" | "closed"): void {
    const found = this.pulls.find((candidate) => candidate.number === pull);
    if (!found) throw new Error(`no pull request #${pull}`);
    found.state = state;
    found.closedAt = this.now();
  }

  ciRun(sha: string, name: string, state: CheckState): void {
    this.ciRuns.set(sha, { ...this.ciRuns.get(sha), [name]: { state, description: "", at: this.now() } });
  }

  labelsOf(issue: number): string[] {
    return [...(this.issues.get(issue)?.labels ?? [])].sort();
  }

  commentBodies(issue: number): string[] {
    return this.comments.filter((comment) => comment.issue === issue && comment.author === BOT && !comment.body.startsWith("<!-- autopilot:claim")).map((comment) => comment.body);
  }

  isHidden(id: number): boolean {
    return this.comments.find((comment) => comment.id === id)?.minimized ?? false;
  }

  statusStates(sha: string): Record<string, CheckState> {
    return Object.fromEntries(Object.entries(this.statusesBySha.get(sha) ?? {}).map(([check, status]) => [check, status.state]));
  }

  headOf(pull: number): string | undefined {
    return this.pulls.find((candidate) => candidate.number === pull)?.head.sha;
  }

  labeledIssues(label: string, open: boolean): Issue[] {
    return [...this.issues.values()]
      .filter((issue) => issue.labels.includes(label) && issue.open === open)
      .map(({ number, title, body, labels }) => ({ number, title, body, labels: [...labels] }));
  }

  // --- RepoGitHub

  async listOpenIssues(label: string): Promise<Issue[]> {
    return this.labeledIssues(label, true);
  }
  async lastLabeled(issue: number, label: string) {
    const found = this.issues.get(issue);
    return found && label === TRIGGER_LABEL ? { actor: found.labeledBy, at: found.labeledAt } : undefined;
  }
  async listComments(issue: number): Promise<Comment[]> {
    return this.comments.filter((comment) => comment.issue === issue).map(({ id, nodeId, author, body, createdAt }) => ({ id, nodeId, author, body, createdAt }));
  }
  async postComment(issue: number, body: string): Promise<void> {
    this.addComment(issue, BOT, body);
  }
  async deleteComment(id: number): Promise<void> {
    this.comments = this.comments.filter((comment) => comment.id !== id);
  }
  async setLabels(issue: number, labels: string[]): Promise<void> {
    this.issue(issue).labels = [...labels];
  }
  async closeIssue(issue: number): Promise<void> {
    this.issue(issue).open = false;
  }
  async ensureLabels(): Promise<void> {}
  async readFile(path: string): Promise<string | undefined> {
    return path === CONFIG_PATH && this.config ? JSON.stringify(this.config) : undefined;
  }
  async minimizeOutdated(commentNodeId: string): Promise<void> {
    const comment = this.comments.find((candidate) => candidate.nodeId === commentNodeId);
    if (comment) comment.minimized = true;
  }
  async commentEditors(commentNodeId: string): Promise<string[]> {
    return [...(this.comments.find((comment) => comment.nodeId === commentNodeId)?.editors ?? [])];
  }
  async provenance(issue: number): Promise<Provenance> {
    const found = this.issue(issue);
    const commentEdits = new Map<number, CommentEdit>();
    for (const comment of this.comments.filter((candidate) => candidate.issue === issue)) {
      commentEdits.set(comment.id, comment.editors.length === 0 ? { edited: false } : { edited: true, by: comment.editors[0] });
    }
    return { body: { by: found.author, at: found.createdAt }, commentEdits };
  }
  async token(): Promise<string> {
    return "token";
  }
  async canChangeWorkflows(): Promise<boolean> {
    return true;
  }
  async defaultBranch(): Promise<string> {
    return "main";
  }
  async isEmpty(): Promise<boolean> {
    return this.empty;
  }
  async lastUnlabeled(): Promise<string | undefined> {
    return undefined;
  }
  async userId(): Promise<number> {
    return 1;
  }
  async botPulls(): Promise<BotPull[]> {
    return this.pulls.filter((pull) => issueOfBranch(pull.head.ref) !== undefined).map(({ number, issue, state, base, head, closedAt }) => ({ number, issue, state, base, head: { ...head }, closedAt }));
  }
  async onboardingPull(): Promise<OnboardingPull | undefined> {
    const pull = this.pulls.findLast((candidate) => candidate.head.ref === ONBOARDING_BRANCH);
    return pull && { number: pull.number, state: pull.state, closedAt: pull.closedAt };
  }
  async pullFiles(pull: number): Promise<FileChange[]> {
    return this.pulls.find((candidate) => candidate.number === pull)?.files ?? [];
  }
  async pullCommits(pull: number): Promise<string[]> {
    const found = this.pulls.find((candidate) => candidate.number === pull);
    return found ? [...(this.branches.get(found.head.ref) ?? [])] : [];
  }
  async statuses(sha: string): Promise<Statuses> {
    return { ...this.statusesBySha.get(sha) };
  }
  async ciStatuses(sha: string, names: string[]): Promise<Statuses> {
    return Object.fromEntries(Object.entries(this.ciRuns.get(sha) ?? {}).filter(([name]) => names.includes(name)));
  }
  async ciOutput(sha: string, name: string): Promise<string> {
    return `CI log of ${name} on ${sha}`;
  }
  async setStatus(sha: string, check: string, state: CheckState, description: string): Promise<void> {
    this.statusesBySha.set(sha, { ...this.statusesBySha.get(sha), [check]: { state, description, at: new Date().toISOString() } });
  }
  async markPushed(sha: string, issue: number): Promise<void> {
    this.pushed.set(sha, issue);
  }
  async pushedFor(sha: string): Promise<number | undefined> {
    return this.pushed.get(sha);
  }
  async compare(_base: string, head: string) {
    return { behind: this.behind.has(head) ? 1 : 0, ahead: 1, changes: [head] };
  }
  async rebasePull(): Promise<string> {
    this.onRebase();
    throw new Error("merge conflict");
  }
  async pullHead(pull: number): Promise<string> {
    return this.pulls.find((candidate) => candidate.number === pull)?.head.sha ?? "";
  }
  async openPull(pull: { head: string; base: string; title: string; body: string }): Promise<number> {
    if (!this.branches.has(pull.head)) throw new Error(`the branch ${pull.head} was not pushed`);
    const number = this.openPullFor(pull.head, pull.base);
    Object.assign(this.pulls[number - 1] ?? {}, { title: pull.title, body: pull.body });
    return number;
  }
  async requestReview(pull: number, reviewers: string[]): Promise<void> {
    this.reviewRequests.push({ pull, reviewers });
  }
  // GitHub refuses a merge when the head moved since the caller read it.
  async mergePull(pull: number, sha: string, title: string, message: string): Promise<void> {
    const found = this.pulls.find((candidate) => candidate.number === pull);
    if (found?.state !== "open" || found.head.sha !== sha) throw new Error(`pull request #${pull} cannot be merged at ${sha}`);
    found.state = "merged";
    found.closedAt = this.now();
    this.merges.push({ pull, sha, title, message });
    this.issue(found.issue).open = false;
  }

  private issue(number: number): FakeIssue {
    const issue = this.issues.get(number);
    if (!issue) throw new Error(`no issue ${number}`);
    return issue;
  }
}

const DEFAULT_FILES: FileChange[] = [{ status: "modified", path: "src/a.ts", additions: 3, deletions: 1 }];

export const LOW_RISK_PLAN: PlannerResult = {
  needs_info: false,
  questions: [],
  scope: "ok",
  risk: "low",
  planned_files: [{ path: "src/a.ts", status: "modified" }],
  spec: "Change src/a.ts.",
};

export const HOST: Host = {
  name: HOST_NAME,
  app_id: 1,
  secrets: { app_key: "op://v/k/f", claude_token: "op://v/c/f" },
  owners: [OWNER],
  allow: [`${REPO.owner}/${REPO.name}`],
  docker: "rootless",
  poll_interval_seconds: 60,
  concurrency: 1,
  limits: { memory: "6g", cpus: 2, pids: 1024 },
};

export const HOST_CONFIG: FakeConfig = {
  version: 1,
  merge: "auto",
  verify: { required: ["lint", "test"], commands: { lint: "pnpm lint", test: "pnpm test" } },
};

// The scripted agents. A test sets these before it runs the loop.
export type Script = {
  plan: PlannerResult;
  planError: Error | undefined;
  buildError: Error | undefined;
  // The checks that fail on the 1st, 2nd... run of the checks. A run past the end passes.
  failingRuns: string[][];
  onboardError: Error | undefined;
  // Another host opens the onboarding pull request while this host's job runs.
  onboardRace: boolean;
};

type WorldRepo = { repo: Repo; github: FakeRepoGitHub; installed: boolean };

export class FakeWorld {
  repo: FakeRepoGitHub;
  repos: WorldRepo[] = [];
  searches = 0;
  nextSearchRateLimit: RateLimited | undefined;
  script: Script = { plan: LOW_RISK_PLAN, planError: undefined, buildError: undefined, failingRuns: [], onboardError: undefined, onboardRace: false };
  planned: number[] = [];
  onboarded: number[] = [];
  builds: BuildJob["mode"][] = [];
  checkRuns = 0;
  logs: string[] = [];
  github: GitHub;
  loop: Loop;
  state: LoopState = loopState();
  private commits = 0;

  constructor(config: FakeConfig = HOST_CONFIG, host: Host = HOST) {
    this.repo = this.addRepo(REPO, { config });
    this.github = {
      app: async () => ({ slug: "autopilot", settingsUrl: "https://github.com/settings/apps/autopilot", workflows: true }),
      appSlug: async () => "autopilot",
      appLogin: async () => BOT,
      findInstallation: async () => 1,
      canChangeWorkflows: async () => false,
      rateLimit: async () => ({ core: FULL_QUOTA, search: FULL_QUOTA }),
      listRepos: async (_, owner) => this.repos.filter((candidate) => candidate.installed && candidate.repo.owner === owner).map((candidate) => candidate.repo),
      searchIssues: async (_, query) => this.search(query),
      repo: (_, repo) => {
        const found = this.repos.find((candidate) => candidate.repo.owner === repo.owner && candidate.repo.name === repo.name);
        if (!found) throw new Error(`no repo ${repo.owner}/${repo.name}`);
        return found.github;
      },
    };
    this.loop = {
      github: this.github,
      host,
      plan: (job) => this.plan(job),
      build: (job) => this.build(job),
      check: (job) => this.check(job),
      onboard: (job) => this.onboard(job),
      log: (_, line) => this.logs.push(line),
      audit: () => undefined,
      claimId: CLAIM_ID,
      idle: { due: () => false, run: async () => undefined },
    };
  }

  addRepo(repo: Repo, { config = HOST_CONFIG, installed = true }: { config?: FakeConfig | undefined; installed?: boolean } = {}): FakeRepoGitHub {
    const github = new FakeRepoGitHub(config);
    this.repos.push({ repo, github, installed });
    return github;
  }

  private async search(query: string): Promise<FoundIssue[]> {
    this.searches++;
    const limit = this.nextSearchRateLimit;
    this.nextSearchRateLimit = undefined;
    if (limit) throw limit;
    const terms = query.split(" ");
    const label = terms.find((term) => term.startsWith("label:"))?.slice("label:".length) ?? "";
    const open = terms.includes("is:open");
    const inScope = (repo: Repo) => terms.includes(`user:${repo.owner}`) || terms.includes(`repo:${repo.owner}/${repo.name}`);
    return this.repos.filter(({ repo }) => inScope(repo)).flatMap(({ repo, github }) => github.labeledIssues(label, open).map((issue) => ({ repo, issue })));
  }

  // One poll of the host: every labeled issue gets one step.
  async poll(times = 1): Promise<void> {
    for (let index = 0; index < times; index++) {
      await pollOnce(this.loop, this.state);
      await drain(this.state);
    }
  }

  private async plan(job: PlannerJob): Promise<PlannerResult> {
    this.planned.push(job.issue.number);
    if (this.script.planError) throw this.script.planError;
    return this.script.plan;
  }

  private async build(job: Omit<BuildJob, "credentials" | "devcontainer" | "audit">): Promise<Built> {
    this.builds.push(job.mode);
    if (this.script.buildError) throw this.script.buildError;
    const head = `sha-${++this.commits}`;
    this.repo.pushCommit(job.mode.branch, head);
    return { head, summary: "Did the change." };
  }

  private async onboard(job: Omit<OnboardJob, "credentials" | "devcontainer" | "audit" | "say">): Promise<Onboarded> {
    this.onboarded.push(job.request.issue.number);
    if (this.script.onboardError) throw this.script.onboardError;
    if (this.script.onboardRace) {
      this.repo.pushCommit(ONBOARDING_BRANCH, "sha-other-host");
      this.repo.openPullFor(ONBOARDING_BRANCH);
      return { kind: "taken" };
    }
    this.repo.pushCommit(ONBOARDING_BRANCH, `sha-${++this.commits}`);
    return { kind: "pushed", body: `Onboards ${job.repo.owner}/${job.repo.name} to autopilot.` };
  }

  private async check(job: Omit<ChecksJob, "devcontainer" | "audit">): Promise<CheckResult[]> {
    const failing = this.script.failingRuns[this.checkRuns++] ?? [];
    return job.config.verify.required.map((check) =>
      failing.includes(check) ? { check, state: "failure", description: `${check} failed`, output: `boom in ${check}` } : { check, state: "success", description: `${check} passed`, output: "" },
    );
  }
}
