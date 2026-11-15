import { setTimeout as sleep } from "node:timers/promises";
import { parseAllowEntry } from "../core/allow.ts";
import type { Audit } from "../core/audit.ts";
import { claimComment, claimOf, ownClaims } from "../core/claim.ts";
import { parseConfig, type Config } from "../core/config.ts";
import { gate1 } from "../core/gate.ts";
import type { GitHub, Issue, RepoGitHub } from "../core/github.ts";
import type { Host } from "../core/host.ts";
import type { PlannerJob, PlannerResult } from "../core/planner.ts";
import type { Repo } from "../core/repo.ts";
import { isApproved, latestSpec, type Comment, ownerReplyAfter, renderSpecComment, specMissingLabel } from "../core/spec.ts";
import { isOwnerTick, isVouched, trustedGate, trustedThread } from "../core/trust.ts";
import { labelsFor, STATES, stateLabel, stateOf, transition, TRIGGER_LABEL, type Event, type IssueState, type State } from "../core/state.ts";

const CONFIG_PATH = ".github/autopilot.json";

const LABELS = [
  { name: TRIGGER_LABEL, color: "000000", description: "autopilot: build this issue" },
  ...Object.entries(STATES).map(([state, label]) => ({ name: `${TRIGGER_LABEL}:${state}`, ...label })),
];

const PLANNER_STATES: IssueState[] = ["new", "spec", "needs-info", "awaiting-approval"];

const CLAIM_SETTLE_MS = 3000;

export type Log = (key: string, line: string) => void;

export type Loop = {
  github: GitHub;
  host: Host;
  plan: (job: PlannerJob) => Promise<PlannerResult>;
  log: Log;
  audit: Audit;
};

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

async function reconcile(loop: Loop, repoGitHub: RepoGitHub, repo: Repo, issue: Issue, labelsReady: Set<string>): Promise<void> {
  const { github, host, log, audit } = loop;
  const key = `${repo.owner}/${repo.name}#${issue.number}`;
  const state = stateOf(issue.labels);
  if (state === "ambiguous") return log(key, `${key}: more than one autopilot:* label, skipped`);
  if (!PLANNER_STATES.includes(state)) return log(key, `${key}: ${state}`);

  const labeled = await repoGitHub.lastLabeled(issue.number, TRIGGER_LABEL);
  if (!labeled || !host.owners.includes(labeled.actor)) {
    return log(key, `${key}: ignored, the ${TRIGGER_LABEL} label was added by ${labeled?.actor ?? "unknown"}, not an owner`);
  }

  const bot = await github.appLogin();
  const comments = await claim(loop, repoGitHub, issue, key, bot, await repoGitHub.listComments(issue.number));
  if (!comments) return;

  let current: IssueState = state;
  let labels = issue.labels;
  async function move(event: Event): Promise<void> {
    const next: State | undefined = transition(current, event);
    if (!next) throw new Error(`${key}: no transition from ${current} on ${event}`);
    labels = labelsFor(labels, next);
    await repoGitHub.setLabels(issue.number, labels);
    audit({ event: "state.changed", issue: key, from: current, to: next });
    log(key, `${key}: ${current} -> ${next}`);
    current = next;
  }

  if (current === "new") {
    const repoKey = `${repo.owner}/${repo.name}`;
    if (!labelsReady.has(repoKey)) {
      await repoGitHub.ensureLabels(LABELS);
      labelsReady.add(repoKey);
    }
    await move("start");
  }

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
    return move("approve");
  }

  if (current !== "spec") return;
  const recorded = specMissingLabel(comments, bot, host.owners, labeled.at);
  const recordedGate = recorded && trustedGate(recorded.body, await repoGitHub.commentEditors(recorded.nodeId));
  if (recordedGate) return move(recordedGate);

  try {
    const config = await readConfig(repoGitHub);
    const provenance = await repoGitHub.provenance(issue.number);
    if (!isVouched(provenance.title ? [provenance.body, provenance.title] : [provenance.body], host.owners, labeled.at)) {
      throw new Blocked(
        `Someone who is not an owner changed the issue title or description after the \`${TRIGGER_LABEL}\` label was added. An owner must edit it, or remove and add the label again, to vouch for the text.`,
      );
    }
    log(key, `${key}: spec, planning with ${config.agents[config.steps.spec].model}`);
    const thread = trustedThread(comments, provenance.commentEdits, bot, host.owners);
    const result = await loop.plan({ github, repoGitHub, repo, host, config, issue, thread }).catch((error: unknown) => {
      log(key, `${key}: planner failed: ${messageOf(error)}${error instanceof Error && error.cause ? `\n${String(error.cause)}` : ""}`);
      throw new Blocked(`The planner failed: ${messageOf(error)}.`);
    });
    const gate = gate1(result, config.risk);
    audit({ event: "gate.decided", issue: key, gate: "gate1", planner: result.risk, rules: gate.rulesRisk, final: gate.risk, scope: result.scope, decision: gate.event });
    await repoGitHub.postComment(issue.number, renderSpecComment(result, gate));
    await move(gate.event);
  } catch (error) {
    if (!(error instanceof Blocked)) throw error;
    await repoGitHub.postComment(
      issue.number,
      `autopilot stopped: ${error.message}\n\nFix it, then remove the \`${stateLabel("blocked")}\` label to try again.`,
    );
    await move("fail");
  }
}

export async function runOnce(loop: Loop, labelsReady = new Set<string>()): Promise<void> {
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
      for (const issue of await repoGitHub.listLabeledIssues(TRIGGER_LABEL)) {
        await reconcile(loop, repoGitHub, repo, issue, labelsReady).catch((error: unknown) =>
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
  const labelsReady = new Set<string>();
  await runOnce(full, labelsReady);
  while (!options.once) {
    await sleep(loop.host.poll_interval_seconds * 1000);
    await runOnce(full, labelsReady);
  }
}
