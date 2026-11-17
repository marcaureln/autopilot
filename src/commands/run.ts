import { setTimeout as sleep } from "node:timers/promises";
import { parseWatchEntry } from "../core/allow.ts";
import { serviceLog, type Audit } from "../core/audit.ts";
import { BASELINE_PATH, parseBaseline, type Baseline } from "../core/baseline.ts";
import { botIdentity, BuildStopped, neutralize, pullBody, SecretsMissing, type BuildJob, type Built, type Failure } from "../core/builder.ts";
import { planChecks, type CheckResult, type ChecksJob } from "../core/checks.ts";
import { claimComment, claimOf, ownClaims } from "../core/claim.ts";
import { CONFIG_PATH, parseConfig, type Config } from "../core/config.ts";
import { EnvironmentRefused } from "../core/environment.ts";
import { gate1, gate2 } from "../core/gate.ts";
import type { GitHub, Issue, RepoGitHub } from "../core/github.ts";
import { usesOnePassword, type Host } from "../core/host.ts";
import { ANY_TIME, branchName, fixVerdict, headVerdict, issuePhase, latestPull, type BotPull, type HeadVerdict, type Statuses } from "../core/phase.ts";
import type { PlannerJob, PlannerResult } from "../core/planner.ts";
import type { Repo } from "../core/repo.ts";
import { refusedSecrets } from "../core/repo-secrets.ts";
import { isApproved, latestSpec, type Comment, ownerReplyAfter, renderSpecComment, specMissingLabel } from "../core/spec.ts";
import { isOwnerTick, isVouched, trustedSpec, trustedThread, type TrustedSpec } from "../core/trust.ts";
import { doneLabels, LABELS, labelsFor, migrateLabels, stateLabel, stateOf, transition, TRIGGER_LABEL, type Event, type IssueState, type State } from "../core/state.ts";

const CLAIM_SETTLE_MS = 3000;

const BLOCKED_OUTPUT_CHARS = 3000;

// GitHub refuses a comment longer than 65,536 characters.
const MAX_COMMENT_CHARS = 60_000;

export type Log = (key: string, line: string) => void;

export type Loop = {
  github: GitHub;
  host: Host;
  plan: (job: PlannerJob) => Promise<PlannerResult>;
  build: (job: Omit<BuildJob, "claudeToken" | "devcontainer" | "audit">) => Promise<Built>;
  check: (job: Omit<ChecksJob, "devcontainer" | "audit">) => Promise<CheckResult[]>;
  log: Log;
  audit: Audit;
  // Host work that must not overlap a job, such as a scanner database update. When it is due, the
  // loop starts no new job, waits for the running ones, then runs it: a long queue cannot hold it back.
  idle: Idle;
};

export type Idle = { due: () => boolean; run: () => Promise<void> };

// GitHub statuses do not hold the check output, so it lives in memory. After a restart, a failed
// check runs again to get its output back.
// `waitingSince` holds when the host first saw a head wait for the repo's CI (`ci` mode).
type RepoContext = { repoGitHub: RepoGitHub; repo: Repo; bot: string; pulls: BotPull[]; outputs: Map<string, CheckResult[]>; waitingSince: Map<string, number> };

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

async function readBaseline(repoGitHub: RepoGitHub): Promise<Baseline> {
  const text = await repoGitHub.readFile(BASELINE_PATH);
  if (text === undefined) return {};
  try {
    return parseBaseline(text);
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
    if (error instanceof SecretsMissing) {
      log(key, `${key}: the builder needs the secrets ${error.names.join(", ")}`);
      await move("needs_info");
      const names = error.names.map((name) => `\`${name}\``).join(", ");
      await repoGitHub.postComment(
        issue.number,
        `The builder needs secrets that the checks do not get: ${names}. In a checkout of this repo, run \`autopilot secrets set <NAME>\` for each one, then reply here. With the 1Password backend, also merge the change to \`.github/autopilot.json\`.`,
      );
      return;
    }
    if (!(error instanceof Blocked || error instanceof BuildStopped || error instanceof EnvironmentRefused)) throw error;
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
      throw new Blocked(`Pull request #${phase.pull.number} was closed without a merge. To build again, remove the label. To change the plan first, comment on the issue.`);
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
  const results = await loop.check({ repo, token: await repoGitHub.token(), pull, commits: commits.length, host: loop.host, config, defaultBranchBaseline: await readBaseline(repoGitHub) });
  const at = new Date().toISOString();
  for (const result of results) await repoGitHub.setStatus(sha, result.check, result.state, result.description);
  ctx.outputs.set(sha, results);
  loop.audit({ event: "checks.ran", issue: key, pull: pull.number, sha, results: Object.fromEntries(results.map((result) => [result.check, result.state])) });
  return Object.fromEntries(results.map((result) => [result.check, { state: result.state, description: result.description, at }]));
}

async function waitForCi(job: Working, config: Config, sha: string): Promise<void> {
  const { loop, ctx, key } = job;
  const since = ctx.waitingSince.get(sha) ?? Date.now();
  ctx.waitingSince.set(sha, since);
  const statuses = await ctx.repoGitHub.ciStatuses(sha, config.verify.required);
  const waiting = config.verify.required.filter((check) => statuses[check] === undefined || statuses[check].state === "pending");
  if (Date.now() - since > config.verify.timeout_minutes * 60 * 1000) {
    ctx.waitingSince.delete(sha);
    throw new Blocked(
      `The repo's CI gave no result for ${waiting.map((check) => `\`${check}\``).join(", ")} on ${sha.slice(0, 7)} within ${config.verify.timeout_minutes} minutes (\`verify.timeout_minutes\`). In \`ci\` mode, \`verify.required\` lists the names of the repo's GitHub Actions jobs.`,
    );
  }
  loop.log(key, `${key}: waits for the repo's CI on ${sha.slice(0, 7)}: ${waiting.join(", ")}`);
}

// Where the checks of a head come from. In `host` mode the host runs them and reads its own statuses.
// In `ci` mode the repo's CI runs them, and its results on a head count whenever they ran: a retry does
// not run that CI again.
type VerifySource = {
  // Passed to `headVerdict`: results older than this do not count.
  since: string;
  results: (commit: string) => Promise<Statuses>;
  // Turns the verdict on the head's results into one to act on, or returns undefined when the results are not there yet.
  settle: (verdict: HeadVerdict) => Promise<Exclude<HeadVerdict, { kind: "run" }> | undefined>;
  failureOutput: (check: string) => Promise<string>;
};

function verifySource(job: Working, config: Config, pull: BotPull, retryAt: string): VerifySource {
  const { ctx } = job;
  const { repoGitHub } = ctx;
  const { required } = config.verify;
  const sha = pull.head.sha;

  if (config.verify.mode === "ci") {
    return {
      since: ANY_TIME,
      results: (commit) => repoGitHub.ciStatuses(commit, required),
      settle: async (verdict) => {
        if (verdict.kind === "run") {
          await waitForCi(job, config, sha);
          return undefined;
        }
        ctx.waitingSince.delete(sha);
        return verdict;
      },
      failureOutput: (check) => repoGitHub.ciOutput(sha, check),
    };
  }

  const missing = planChecks(required, config.verify.commands).filter((plan) => plan.kind === "missing");
  if (missing.length > 0) throw new Blocked(`\`verify.required\` lists ${missing.map((plan) => `\`${plan.check}\``).join(", ")} with no command in \`verify.commands\`.`);
  return {
    since: retryAt,
    results: (commit) => repoGitHub.statuses(commit, ctx.bot),
    settle: async (verdict) => {
      // A failed head whose output is gone (after a restart) runs again to get it back.
      const reran = verdict.kind === "run" || (verdict.kind === "failed" && !ctx.outputs.has(sha));
      const settled = reran ? headVerdict(await runChecks(job, config, pull), required, retryAt) : verdict;
      if (settled.kind === "run") throw new Error(`${job.key}: the checks on ${sha.slice(0, 7)} left no result`);
      return settled;
    },
    failureOutput: async (check) => {
      const result = ctx.outputs.get(sha)?.find((output) => output.check === check);
      return result ? `${result.description}\n\n${result.output}` : "";
    },
  };
}

// The checks read the config of the default branch, so they run on a branch that has its latest commits.
// The result is marked as pushed by the host, so the host rebases only its own head onto the default
// branch, and marks the result only when it brings exactly the same changes. Returns whether it rebased.
async function rebaseWhenBehind(job: Working, pull: BotPull, defaultBranch: string, pushedByAutopilot: boolean): Promise<boolean> {
  const { loop, ctx, issue, key } = job;
  const { repoGitHub } = ctx;
  const sha = pull.head.sha;
  if (!pushedByAutopilot || pull.base !== defaultBranch) return false;
  const before = await repoGitHub.compare(defaultBranch, sha);
  if (before.behind === 0) return false;
  const head = await repoGitHub.rebasePull(pull.number, sha).catch((error: unknown) => {
    throw new Blocked(`autopilot could not rebase pull request #${pull.number} on \`${pull.base}\`: ${messageOf(error)}. Close the pull request, then remove the label to build again.`);
  });
  const after = await repoGitHub.compare(defaultBranch, head);
  if (head === sha || after.behind > 0 || after.ahead !== before.ahead || after.changes.join("\n") !== before.changes.join("\n")) {
    throw new Blocked(`The rebase of pull request #${pull.number} on \`${pull.base}\` gave ${head.slice(0, 7)}, which does not bring the same changes as ${sha.slice(0, 7)}. Close the pull request, then remove the label to build again.`);
  }
  await repoGitHub.markPushed(head, issue.number);
  loop.audit({ event: "pr.rebased", repo: `${ctx.repo.owner}/${ctx.repo.name}`, pull: pull.number, issue: issue.number, from: sha, to: head });
  loop.log(key, `${key}: rebased #${pull.number} on ${pull.base} to ${head.slice(0, 7)}, the checks run next`);
  return true;
}

async function checksAndGate2(job: Working, config: Config, pull: BotPull, retryAt: string, currentSpec: () => Promise<TrustedSpec | undefined>): Promise<void> {
  const { loop, ctx, issue, key } = job;
  const { repoGitHub } = ctx;
  const required = config.verify.required;
  const verify = verifySource(job, config, pull, retryAt);
  const refused = refusedSecrets(ctx.repo, config.secrets);
  if (refused.length > 0) {
    const names = refused.map((name) => `\`${name}\``).join(", ");
    throw new Blocked(`The \`secrets\` in \`${CONFIG_PATH}\` for ${names} do not point to this repo's own 1Password item. Set each one again with \`autopilot secrets set --backend op <NAME>\`.`);
  }
  if (config.verify.mode === "host" && Object.keys(config.secrets).length > 0 && !usesOnePassword(loop.host.secrets)) {
    throw new Blocked(
      `The \`secrets\` in \`${CONFIG_PATH}\` are 1Password references, and this host has no 1Password. Set each one again with \`autopilot secrets set <NAME>\` (the env backend), or set up the host with 1Password.`,
    );
  }
  const sha = pull.head.sha;
  // Someone with write access can push to the bot's branch. Only a head the host pushed for this
  // issue is fixed or merged; its ancestors are then the host's commits too.
  const pushedByAutopilot = (await repoGitHub.pushedFor(sha, ctx.bot)) === issue.number;

  const head = headVerdict(await verify.results(sha), required, verify.since);
  const defaultBranch = await repoGitHub.defaultBranch();
  if (head.kind === "run" && (await rebaseWhenBehind(job, pull, defaultBranch, pushedByAutopilot))) return;
  const verdict = await verify.settle(head);
  if (verdict === undefined) return;

  if (verdict.kind === "failed") {
    const commits = await repoGitHub.pullCommits(pull.number);
    const earlier: Statuses[] = [];
    for (const commit of commits.slice(0, -1).reverse()) earlier.push(await verify.results(commit));
    const fix = fixVerdict(verdict.failing, earlier, required, config.limits.fix_rounds, retryAt);
    const failures: Failure[] = [];
    for (const check of verdict.failing) failures.push({ check, output: await verify.failureOutput(check) });
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
    intoDefaultBranch: pull.base === defaultBranch,
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

// `running` holds one job per issue: an issue never runs twice at once, and at most
// `host.concurrency` issues run together.
export type LoopState = { labelsReady: Set<string>; outputs: Map<string, CheckResult[]>; waitingSince: Map<string, number>; running: Map<string, Promise<void>> };

export function loopState(): LoopState {
  return { labelsReady: new Set(), outputs: new Map(), waitingSince: new Map(), running: new Map() };
}

// Starts the jobs and returns without waiting for them: see `drain`. An error on one entry or repo
// is logged, so it does not stop the loop for the others.
export async function runOnce(loop: Loop, state: LoopState): Promise<void> {
  const { github, log } = loop;
  for (const value of loop.host.allow) {
    const entry = parseWatchEntry(value);
    const installationId = await github.findInstallation(entry).catch((error: unknown) => {
      log(value, `${value}: error: ${messageOf(error)}`);
      return null;
    });
    if (installationId === null) continue;
    if (installationId === undefined) {
      log(value, `not installed: ${value}`);
      continue;
    }
    const repos = entry.repo ? [{ owner: entry.owner, name: entry.repo }] : await github.listRepos(installationId, entry.owner).catch((error: unknown) => {
      log(value, `${value}: error: ${messageOf(error)}`);
      return [];
    });
    for (const repo of repos) {
      const repoKey = `${repo.owner}/${repo.name}`;
      await pollRepo(loop, state, installationId, repo).catch((error: unknown) => log(repoKey, `${repoKey}: error: ${messageOf(error)}`));
    }
  }
}

async function pollRepo(loop: Loop, state: LoopState, installationId: number, repo: Repo): Promise<void> {
  const { github, host, log } = loop;
  const repoGitHub = github.repo(installationId, repo);
  const repoKey = `${repo.owner}/${repo.name}`;
  for (const closed of await repoGitHub.listLabeledIssues(TRIGGER_LABEL, "closed")) {
    const key = `${repoKey}#${closed.number}`;
    await repoGitHub.setLabels(closed.number, doneLabels(closed.labels)).then(
      () => log(key, `${key}: closed, autopilot labels removed`),
      (error: unknown) => log(key, `${key}: error: ${messageOf(error)}`),
    );
  }
  const issues = (await repoGitHub.listLabeledIssues(TRIGGER_LABEL, "open")).filter((issue) => !state.running.has(`${repoKey}#${issue.number}`));
  if (issues.length === 0 || state.running.size >= host.concurrency) return;
  if (!state.labelsReady.has(repoKey)) {
    await repoGitHub.ensureLabels(LABELS);
    state.labelsReady.add(repoKey);
  }
  const bot = await github.appLogin();
  const ctx: RepoContext = { repoGitHub, repo, bot, pulls: await repoGitHub.botPulls(bot), outputs: state.outputs, waitingSince: state.waitingSince };
  for (const issue of issues) {
    if (state.running.size >= host.concurrency) break;
    const key = `${repoKey}#${issue.number}`;
    const job = reconcile(loop, ctx, issue)
      .catch((error: unknown) => log(key, `${key}: error: ${messageOf(error)}`))
      .finally(() => state.running.delete(key));
    state.running.set(key, job);
  }
}

export async function drain(state: LoopState): Promise<void> {
  while (state.running.size > 0) await Promise.all(state.running.values());
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
  const full: Loop = { ...loop, log: changesOnly(serviceLog) };
  const state = loopState();
  await runOnce(full, state);
  if (options.once) return drain(state);
  for (;;) {
    if (loop.idle.due()) {
      await drain(state);
      await loop.idle.run();
    }
    await sleep(loop.host.poll_interval_seconds * 1000);
    await runOnce(full, state);
  }
}
