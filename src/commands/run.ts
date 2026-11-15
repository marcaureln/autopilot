import { setTimeout as sleep } from "node:timers/promises";
import { parseAllowEntry } from "../core/allow.ts";
import type { Audit } from "../core/audit.ts";
import { botIdentity, BuildStopped, neutralize, pullBody, type BuildJob, type Built, type Failure } from "../core/builder.ts";
import { planChecks, type CheckResult, type ChecksJob } from "../core/checks.ts";
import { claimComment, claimOf, ownClaims } from "../core/claim.ts";
import { parseConfig, type Config } from "../core/config.ts";
import { gate1, gate2 } from "../core/gate.ts";
import type { GitHub, Issue, RepoGitHub } from "../core/github.ts";
import type { Host } from "../core/host.ts";
import { branchName, fixVerdict, headVerdict, issuePhase, latestPull, type BotPull, type Statuses } from "../core/phase.ts";
import type { PlannerJob, PlannerResult } from "../core/planner.ts";
import type { Repo } from "../core/repo.ts";
import { isApproved, latestSpec, type Comment, ownerReplyAfter, renderSpecComment, specMissingLabel } from "../core/spec.ts";
import { isOwnerTick, isVouched, trustedSpec, trustedThread, type TrustedSpec } from "../core/trust.ts";
import { labelsFor, migrateLabels, STATES, stateLabel, stateOf, transition, TRIGGER_LABEL, type Event, type IssueState, type State } from "../core/state.ts";

const CONFIG_PATH = ".github/autopilot.json";

const LABELS = [
  { name: TRIGGER_LABEL, color: "000000", description: "autopilot: build this issue" },
  ...Object.entries(STATES).map(([state, label]) => ({ name: `${TRIGGER_LABEL}:${state}`, ...label })),
];

const CLAIM_SETTLE_MS = 3000;

const BLOCKED_OUTPUT_CHARS = 3000;

// GitHub refuses a comment longer than 65,536 characters.
const MAX_COMMENT_CHARS = 60_000;

export type Log = (key: string, line: string) => void;

export type Loop = {
  github: GitHub;
  host: Host;
  plan: (job: PlannerJob) => Promise<PlannerResult>;
  build: (job: Omit<BuildJob, "claudeToken" | "audit">) => Promise<Built>;
  check: (job: Omit<ChecksJob, "audit">) => Promise<CheckResult[]>;
  log: Log;
  audit: Audit;
};

// GitHub statuses do not hold the check output, so it lives in memory. After a restart, a failed
// check runs again to get its output back.
type RepoContext = { repoGitHub: RepoGitHub; repo: Repo; bot: string; pulls: BotPull[]; outputs: Map<string, CheckResult[]> };

class Blocked extends Error {}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function readConfig(repoGitHub: RepoGitHub): Promise<Config> {
  const text = await repoGitHub.readFile(CONFIG_PATH);
  if (text === undefined) throw new Blocked(`There is no \`${CONFIG_PATH}\` on the default branch.`);
  try {
    return parseConfig(text, CONFIG_PATH);
  } catch (error) {
    throw new Blocked(messageOf(error));
  }
}

function later(a: string, b: string | undefined): string {
  return b !== undefined && Date.parse(b) > Date.parse(a) ? b : a;
}

function codeBlock(text: string): string {
  const cut = text.length > BLOCKED_OUTPUT_CHARS ? `[... cut ...]\n${text.slice(-BLOCKED_OUTPUT_CHARS)}` : text;
  return `\`\`\`\n${cut.replaceAll("```", "\'\'\'") || "(no output)"}\n\`\`\``;
}

function reviewMarker(pull: number): string {
  return `<!-- autopilot:review pr=${pull} -->`;
}

async function claim(loop: Loop, repoGitHub: RepoGitHub, issue: Issue, key: string, bot: string, comments: Comment[]): Promise<Comment[] | undefined> {
  const { host, log, audit } = loop;
  let current = claimOf(comments, bot, host.name);
  if (current.kind === "mine") return comments;
  if (current.kind === "free") {
    await repoGitHub.postComment(issue.number, claimComment(host.name));
    await sleep(CLAIM_SETTLE_MS);
    comments = await repoGitHub.listComments(issue.number);
    current = claimOf(comments, bot, host.name);
    if (current.kind === "mine") {
      audit({ event: "issue.claimed", issue: key, host: host.name });
      log(key, `${key}: claimed by host ${host.name}`);
      return comments;
    }
  }
  const lost = ownClaims(comments, bot, host.name);
  for (const own of lost) await repoGitHub.deleteComment(own.id);
  const winner = current.kind === "theirs" ? current.host : "unknown";
  log(key, `${key}: claimed by host ${winner}, skipped${lost.length > 0 ? ` (lost the race, deleted ${lost.length} own claim)` : ""}`);
  return undefined;
}

async function reconcile(loop: Loop, ctx: RepoContext, issue: Issue): Promise<void> {
  const { github, host, log, audit } = loop;
  const { repoGitHub, repo, bot } = ctx;
  const key = `${repo.owner}/${repo.name}#${issue.number}`;
  const migrated = migrateLabels(issue.labels);
  let labels = migrated ?? issue.labels;
  const state = stateOf(labels);
  if (state === "ambiguous") return log(key, `${key}: more than one autopilot:* label, skipped`);
  if (state === "blocked") return log(key, `${key}: ${state}`);

  const labeled = await repoGitHub.lastLabeled(issue.number, TRIGGER_LABEL);
  if (!labeled || !host.owners.includes(labeled.actor)) {
    return log(key, `${key}: ignored, the ${TRIGGER_LABEL} label was added by ${labeled?.actor ?? "unknown"}, not an owner`);
  }

  const comments = await claim(loop, repoGitHub, issue, key, bot, await repoGitHub.listComments(issue.number));
  if (!comments) return;

  if (migrated) {
    await repoGitHub.setLabels(issue.number, labels);
    log(key, `${key}: labels moved to the five-label set (${issue.labels.join(", ")} -> ${labels.join(", ")})`);
  }

  let current: IssueState = state;
  async function move(event: Event): Promise<void> {
    const next: State | undefined = transition(current, event);
    if (!next) throw new Error(`${key}: no transition from ${current} on ${event}`);
    labels = labelsFor(labels, next);
    await repoGitHub.setLabels(issue.number, labels);
    audit({ event: "state.changed", issue: key, from: current, to: next });
    log(key, `${key}: ${current} -> ${next}`);
    current = next;
  }

  try {
    if (current === "new") await move("start");

    const spec = latestSpec(comments, bot);

    if (current === "needs-info") {
      const reply = spec && ownerReplyAfter(comments, host.owners, spec);
      if (!spec || !reply) return log(key, `${key}: ${current}`);
      // Hidden before the label change: after a crash in between, the reply is still newer than the spec, so the next loop retries.
      await repoGitHub.minimizeOutdated(spec.nodeId);
      await move("reply");
    }

    if (current === "awaiting-approval") {
      if (!spec || !isApproved(spec.body)) return log(key, `${key}: ${current}`);
      const editors = await repoGitHub.commentEditors(spec.nodeId);
      if (!isOwnerTick(spec.body, editors, host.owners)) {
        audit({ event: "approval.refused", issue: key, editors });
        return log(key, `${key}: ${current}, ticked but edited by a non-owner (${editors.join(", ")}); remove ${stateLabel(current)} for a new spec`);
      }
      audit({ event: "approval.accepted", issue: key, editors });
      await move("approve");
    }

    if (current === "working") await working({ loop, ctx, issue, key, comments, labeledAt: labeled.at, move });
  } catch (error) {
    if (!(error instanceof Blocked || error instanceof BuildStopped)) throw error;
    log(key, `${key}: blocked: ${error.message}`);
    // The label first: if the comment fails, the job still stops instead of running again on each loop.
    await move("fail");
    // The message can carry agent text.
    const message = neutralize(error.message).slice(0, MAX_COMMENT_CHARS);
    await repoGitHub.postComment(issue.number, `autopilot stopped: ${message}\n\nFix it, then remove the \`${stateLabel("blocked")}\` label to try again.`);
  }
}

type Working = {
  loop: Loop;
  ctx: RepoContext;
  issue: Issue;
  key: string;
  comments: Comment[];
  labeledAt: string;
  move: (event: Event) => Promise<void>;
};

async function working(job: Working): Promise<void> {
  const { loop, ctx, issue, key, comments, labeledAt, move } = job;
  const { host, log } = loop;
  const { repoGitHub, bot } = ctx;

  async function currentSpec(): Promise<TrustedSpec | undefined> {
    const comment = specMissingLabel(comments, bot, host.owners, labeledAt);
    return comment && trustedSpec(comment.body, await repoGitHub.commentEditors(comment.nodeId), host.owners);
  }

  // Removing autopilot:blocked restarts the job: pull requests and statuses from before do not count.
  const retryAt = later(labeledAt, await repoGitHub.lastUnlabeled(issue.number, stateLabel("blocked"), host.owners));
  const pull = latestPull(ctx.pulls, issue.number);
  const phase = issuePhase(pull?.state === "open" ? undefined : await currentSpec(), pull, retryAt);

  switch (phase.kind) {
    case "spec":
      return writeSpec(job);
    case "gate1":
      return move(phase.event);
    case "build":
      return build(job);
    case "merged":
      return log(key, `${key}: pull request #${phase.pull.number} is merged`);
    case "closed":
      throw new Blocked(`Pull request #${phase.pull.number} was closed without a merge. To build again, remove the label; to change the plan first, comment on the issue.`);
    case "pull": {
      const config = await readConfig(repoGitHub);
      return checksAndGate2(job, config, phase.pull, retryAt, currentSpec);
    }
  }
}

async function vouchedThread(job: Working): Promise<Comment[]> {
  const { loop, ctx, issue, comments, labeledAt } = job;
  const provenance = await ctx.repoGitHub.provenance(issue.number);
  if (!isVouched(provenance.title ? [provenance.body, provenance.title] : [provenance.body], loop.host.owners, labeledAt)) {
    throw new Blocked(
      `Someone who is not an owner changed the issue title or description after the \`${TRIGGER_LABEL}\` label was added. An owner must edit it, or remove and add the label again, to vouch for the text.`,
    );
  }
  return trustedThread(comments, provenance.commentEdits, ctx.bot, loop.host.owners);
}

async function writeSpec(job: Working): Promise<void> {
  const { loop, ctx, issue, key, move } = job;
  const { github, host, log, audit } = loop;
  const config = await readConfig(ctx.repoGitHub);
  const thread = await vouchedThread(job);
  log(key, `${key}: spec, planning with ${config.agents[config.steps.spec].model}`);
  const result = await loop.plan({ github, repoGitHub: ctx.repoGitHub, repo: ctx.repo, host, config, issue, thread }).catch((error: unknown) => {
    log(key, `${key}: planner failed: ${messageOf(error)}${error instanceof Error && error.cause ? `\n${String(error.cause)}` : ""}`);
    throw new Blocked(`The planner failed: ${messageOf(error)}.`);
  });
  const gate = gate1(result, config.risk);
  audit({ event: "gate.decided", issue: key, gate: "gate1", planner: result.risk, rules: gate.rulesRisk, final: gate.risk, scope: result.scope, decision: gate.event });
  await ctx.repoGitHub.postComment(issue.number, renderSpecComment(result, gate));
  if (gate.event !== "go") await move(gate.event);
}

async function identityOf(ctx: RepoContext) {
  return botIdentity(ctx.bot, await ctx.repoGitHub.userId(ctx.bot));
}

async function build(job: Working): Promise<void> {
  const { loop, ctx, issue, key } = job;
  const { github, host, log, audit } = loop;
  const { repoGitHub, repo } = ctx;
  const config = await readConfig(repoGitHub);
  const thread = await vouchedThread(job);
  const base = await repoGitHub.defaultBranch();
  const branch = branchName(issue.number, issue.title);
  log(key, `${key}: build on ${branch} with ${config.agents[config.steps.build].model}`);
  const built = await loop.build({ github, repoGitHub, repo, host, config, issue, thread, identity: await identityOf(ctx), mode: { kind: "build", base, branch } });
  await repoGitHub.markPushed(built.head, issue.number);
  const pull = await repoGitHub.openPull({ head: branch, base, title: issue.title, body: pullBody(issue.number, built.summary) }).catch((error: unknown) => {
    throw new Blocked(`autopilot pushed ${branch} but could not open the pull request: ${messageOf(error)}`);
  });
  audit({ event: "pr.opened", repo: `${repo.owner}/${repo.name}`, pull, issue: issue.number, branch });
  log(key, `${key}: opened pull request #${pull} at ${built.head.slice(0, 7)}`);
}

async function runChecks(job: Working, config: Config, pull: BotPull): Promise<Statuses> {
  const { loop, ctx, key } = job;
  const { repoGitHub, repo } = ctx;
  const sha = pull.head.sha;
  const required = config.verify.required;
  for (const check of required) await repoGitHub.setStatus(sha, check, "pending", "running");
  loop.log(key, `${key}: checks on #${pull.number} at ${sha.slice(0, 7)}: ${required.join(", ")}`);
  const commits = await repoGitHub.pullCommits(pull.number);
  const results = await loop.check({ repo, token: await repoGitHub.token(), pull, commits: commits.length, host: loop.host, config });
  const at = new Date().toISOString();
  for (const result of results) await repoGitHub.setStatus(sha, result.check, result.state, result.description);
  ctx.outputs.set(sha, results);
  loop.audit({ event: "checks.ran", issue: key, pull: pull.number, sha, results: Object.fromEntries(results.map((result) => [result.check, result.state])) });
  return Object.fromEntries(results.map((result) => [result.check, { state: result.state, description: result.description, at }]));
}

async function checksAndGate2(job: Working, config: Config, pull: BotPull, retryAt: string, currentSpec: () => Promise<TrustedSpec | undefined>): Promise<void> {
  const { loop, ctx, issue, key } = job;
  const { repoGitHub } = ctx;
  if (config.verify.mode === "remote") throw new Blocked("`verify.mode` `remote` is not supported yet.");
  const required = config.verify.required;
  const missing = planChecks(required, config.verify.commands).filter((plan) => plan.kind === "missing");
  if (missing.length > 0) throw new Blocked(`\`verify.required\` lists ${missing.map((plan) => `\`${plan.check}\``).join(", ")} with no command in \`verify.commands\`.`);
  const sha = pull.head.sha;
  // Someone with write access can push to the bot's branch. Only a head the host pushed for this
  // issue is fixed or merged; its ancestors are then the host's commits too.
  const pushedByAutopilot = (await repoGitHub.pushedFor(sha, ctx.bot)) === issue.number;

  let verdict = headVerdict(await repoGitHub.statuses(sha, ctx.bot), required, retryAt);
  if (verdict.kind === "run" || (verdict.kind === "failed" && !ctx.outputs.has(sha))) {
    verdict = headVerdict(await runChecks(job, config, pull), required, retryAt);
  }
  if (verdict.kind === "run") throw new Error(`${key}: the checks on ${sha.slice(0, 7)} left no result`);

  if (verdict.kind === "failed") {
    const commits = await repoGitHub.pullCommits(pull.number);
    const earlier: Statuses[] = [];
    for (const commit of commits.slice(0, -1).reverse()) earlier.push(await repoGitHub.statuses(commit, ctx.bot));
    const fix = fixVerdict(verdict.failing, earlier, required, config.limits.fix_rounds, retryAt);
    const outputs = ctx.outputs.get(sha) ?? [];
    const failures: Failure[] = verdict.failing.map((check) => {
      const result = outputs.find((output) => output.check === check);
      return { check, output: result ? `${result.description}\n\n${result.output}` : "" };
    });
    if (!pushedByAutopilot) throw new Blocked(`Someone else pushed ${sha.slice(0, 7)} to \`${pull.head.ref}\`, and its checks fail. autopilot does not build on it.`);
    if (fix.kind === "blocked") {
      const why =
        fix.reason === "repeated"
          ? `The check ${fix.checks.map((check) => `\`${check}\``).join(", ")} failed twice in a row on pull request #${pull.number}.`
          : `The checks still fail on pull request #${pull.number} after ${fix.rounds} fix rounds (\`limits.fix_rounds\`).`;
      throw new Blocked(`${why}\n\n${failures.map(({ check, output }) => `**${check}**\n\n${codeBlock(output)}`).join("\n\n")}`);
    }
    loop.log(key, `${key}: fix round ${fix.round} for ${verdict.failing.join(", ")} on #${pull.number}`);
    const thread = await vouchedThread(job);
    const built = await loop.build({
      github: loop.github,
      repoGitHub,
      repo: ctx.repo,
      host: loop.host,
      config,
      issue,
      thread,
      identity: await identityOf(ctx),
      mode: { kind: "fix", branch: pull.head.ref, head: sha, failures },
    });
    await repoGitHub.markPushed(built.head, issue.number);
    return loop.log(key, `${key}: fix round ${fix.round} pushed ${built.head.slice(0, 7)} to #${pull.number}`);
  }

  const marker = reviewMarker(pull.number);
  if (job.comments.some((comment) => comment.author === ctx.bot && comment.body.startsWith(marker))) {
    return loop.log(key, `${key}: pull request #${pull.number} waits for a review`);
  }
  const spec = await currentSpec();
  const facts = {
    changes: await repoGitHub.pullFiles(pull.number),
    plannerRisk: spec?.plannerRisk,
    pushedByAutopilot,
    intoDefaultBranch: pull.base === (await repoGitHub.defaultBranch()),
  };
  const gate = gate2(facts, config);
  loop.audit({ event: "gate.decided", issue: key, gate: "gate2", pull: pull.number, planner: spec?.plannerRisk, rules: gate.rulesRisk, merge: config.merge, decision: gate.decision });
  const repoName = `${ctx.repo.owner}/${ctx.repo.name}`;
  if (gate.decision === "merge") {
    await repoGitHub.mergePull(pull.number, sha, `${issue.title} (#${pull.number})`, `Fixes #${issue.number}`);
    loop.audit({ event: "pr.merged", repo: repoName, pull: pull.number, sha });
    return loop.log(key, `${key}: merged pull request #${pull.number}`);
  }
  // The marker first: Gate 2 must not run again on each loop when the review request fails.
  await repoGitHub.postComment(
    issue.number,
    `${marker}\nPull request #${pull.number} passed every check and waits for a review: ${gate.reasons.join("; ")}.`,
  );
  const reviewers = loop.host.owners;
  await repoGitHub.requestReview(pull.number, reviewers).then(
    () => loop.audit({ event: "review.requested", repo: repoName, pull: pull.number, reviewers }),
    (error: unknown) => loop.log(key, `${key}: could not request a review from ${reviewers.join(", ")}: ${messageOf(error)}`),
  );
  loop.log(key, `${key}: pull request #${pull.number} waits for a review (${gate.reasons.join("; ")})`);
}

export type LoopState = { labelsReady: Set<string>; outputs: Map<string, CheckResult[]> };

export function loopState(): LoopState {
  return { labelsReady: new Set(), outputs: new Map() };
}

export async function runOnce(loop: Loop, state = loopState()): Promise<void> {
  const { github, host, log } = loop;
  for (const value of host.allow) {
    const entry = parseAllowEntry(value);
    const installationId = await github.findInstallation(entry);
    if (installationId === undefined) {
      log(value, `not installed: ${value}`);
      continue;
    }
    const repos = entry.repo ? [{ owner: entry.owner, name: entry.repo }] : await github.listRepos(installationId, entry.owner);
    for (const repo of repos) {
      const repoGitHub = github.repo(installationId, repo);
      const issues = await repoGitHub.listLabeledIssues(TRIGGER_LABEL);
      if (issues.length === 0) continue;
      const repoKey = `${repo.owner}/${repo.name}`;
      if (!state.labelsReady.has(repoKey)) {
        await repoGitHub.ensureLabels(LABELS);
        state.labelsReady.add(repoKey);
      }
      const bot = await github.appLogin();
      const ctx: RepoContext = { repoGitHub, repo, bot, pulls: await repoGitHub.botPulls(bot), outputs: state.outputs };
      for (const issue of issues) {
        await reconcile(loop, ctx, issue).catch((error: unknown) =>
          log(`${repo.owner}/${repo.name}#${issue.number}`, `${repo.owner}/${repo.name}#${issue.number}: error: ${messageOf(error)}`),
        );
      }
    }
  }
}

export function changesOnly(print: (line: string) => void): Log {
  const last = new Map<string, string>();
  return (key, line) => {
    if (last.get(key) === line) return;
    last.set(key, line);
    print(line);
  };
}

export async function run(loop: Omit<Loop, "log">, options: { once: boolean }): Promise<void> {
  const full: Loop = { ...loop, log: changesOnly((line) => console.log(line)) };
  const state = loopState();
  await runOnce(full, state);
  while (!options.once) {
    await sleep(loop.host.poll_interval_seconds * 1000);
    await runOnce(full, state);
  }
}
