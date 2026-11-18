import { test } from "node:test";
import assert from "node:assert/strict";
import { branchName, checkRunState, fixVerdict, headVerdict, issueOfBranch, issuePhase, latestPull, type BotPull, type CheckState, type FixVerdict, type HeadVerdict, type Phase, type Statuses } from "./phase.ts";
type TrustedSpec = Parameters<typeof issuePhase>[0] & { plannerRisk: "low" | "high" };

const RETRY_AT = "2026-11-15T10:00:00Z";
const BEFORE = "2026-11-15T09:00:00Z";
const AFTER = "2026-11-15T11:00:00Z";

const go: TrustedSpec = { gate: "go", plannerRisk: "low", buildAllowed: true };
const approval: TrustedSpec = { gate: "approval_required", plannerRisk: "high", buildAllowed: false };
const ticked: TrustedSpec = { ...approval, buildAllowed: true };
const questions: TrustedSpec = { gate: "needs_info", plannerRisk: "low", buildAllowed: false };

function pull(state: BotPull["state"], closedAt?: string): BotPull {
  return { number: 12, issue: 7, state, base: "main", head: { ref: "autopilot/7-x", sha: "abc" }, closedAt };
}

const phaseCases: { name: string; spec?: TrustedSpec; pull?: BotPull; expected: Phase["kind"] | Phase }[] = [
  { name: "no spec yet", expected: "spec" },
  { name: "a go spec and no pull request", spec: go, expected: "build" },
  { name: "an approval spec ticked by an owner", spec: ticked, expected: "build" },
  { name: "an approval spec not ticked", spec: approval, expected: { kind: "plan", event: "approval_required" } },
  { name: "a questions spec", spec: questions, expected: { kind: "plan", event: "needs_info" } },
  { name: "an open pull request", spec: go, pull: pull("open"), expected: "pull" },
  { name: "an open pull request wins over a missing spec", pull: pull("open"), expected: "pull" },
  { name: "a pull request closed after the restart", spec: go, pull: pull("closed", AFTER), expected: "closed" },
  { name: "a pull request merged after the restart", spec: go, pull: pull("merged", AFTER), expected: "merged" },
  { name: "a pull request closed before the restart is history", spec: go, pull: pull("closed", BEFORE), expected: "build" },
  { name: "a pull request merged before the restart is history", pull: pull("merged", BEFORE), expected: "spec" },
];

for (const { name, spec, pull, expected } of phaseCases) {
  test(`phase: ${name}`, () => {
    const phase = issuePhase(spec, pull, RETRY_AT);
    if (typeof expected === "string") assert.equal(phase.kind, expected);
    else assert.deepEqual(phase, expected);
  });
}

test("the latest pull request of an issue is the one with the highest number", () => {
  const pulls = [
    { ...pull("closed", AFTER), number: 3 },
    { ...pull("open"), number: 9 },
    { ...pull("open"), number: 11, issue: 8 },
  ];
  assert.equal(latestPull(pulls, 7)?.number, 9);
  assert.equal(latestPull(pulls, 5), undefined);
});

const branchCases: { issue: number; title: string; expected: string }[] = [
  { issue: 7, title: "Add a CONTRIBUTING.md", expected: "autopilot/7-add-a-contributing-md" },
  { issue: 12, title: "  Fix: crash on ÉTÉ dates!! ", expected: "autopilot/12-fix-crash-on-t-dates" },
  { issue: 3, title: "!!!", expected: "autopilot/3-change" },
  { issue: 4, title: "a very long title that goes on and on and on forever", expected: "autopilot/4-a-very-long-title-that-goes-on-and-on" },
];

for (const { issue, title, expected } of branchCases) {
  test(`branch for #${issue} "${title}"`, () => {
    assert.equal(branchName(issue, title), expected);
    assert.equal(issueOfBranch(expected), issue);
  });
}

test("only autopilot branches link to an issue", () => {
  assert.equal(issueOfBranch("main"), undefined);
  assert.equal(issueOfBranch("feature/7-x"), undefined);
  assert.equal(issueOfBranch("autopilot/x-7"), undefined);
});

const REQUIRED = ["lint", "test", "sast"];

function statuses(states: Record<string, Statuses[string]["state"]>, at = AFTER): Statuses {
  return Object.fromEntries(Object.entries(states).map(([check, state]) => [check, { state, description: "", at }]));
}

const green = statuses({ lint: "success", test: "success", sast: "success" });

const headCases: { name: string; head: Statuses; expected: HeadVerdict }[] = [
  { name: "no status yet", head: {}, expected: { kind: "run" } },
  { name: "one required check missing", head: statuses({ lint: "success", test: "success" }), expected: { kind: "run" } },
  { name: "a pending check left by a stopped run", head: statuses({ lint: "success", test: "pending", sast: "success" }), expected: { kind: "run" } },
  { name: "statuses from before the restart", head: statuses({ lint: "failure", test: "success", sast: "success" }, BEFORE), expected: { kind: "run" } },
  { name: "all green", head: green, expected: { kind: "green" } },
  { name: "a check that is not required does not count", head: { ...green, ...statuses({ extra: "failure" }) }, expected: { kind: "green" } },
  { name: "failure and error both fail", head: statuses({ lint: "failure", test: "error", sast: "success" }), expected: { kind: "failed", failing: ["lint", "test"] } },
];

for (const { name, head, expected } of headCases) {
  test(`head: ${name}`, () => {
    assert.deepEqual(headVerdict(head, REQUIRED, RETRY_AT), expected);
  });
}

const fixCases: { name: string; failing: string[]; earlier: Statuses[]; rounds?: number; expected: FixVerdict }[] = [
  { name: "first failure", failing: ["lint"], earlier: [], expected: { kind: "fix", round: 1 } },
  { name: "a commit with no status is not a round", failing: ["lint"], earlier: [{}, {}], expected: { kind: "fix", round: 1 } },
  {
    name: "another check failed before",
    failing: ["lint"],
    earlier: [statuses({ lint: "success", test: "failure", sast: "success" })],
    expected: { kind: "fix", round: 2 },
  },
  {
    name: "the same check failed twice in a row",
    failing: ["lint", "sast"],
    earlier: [statuses({ lint: "failure", test: "success", sast: "error" })],
    expected: { kind: "blocked", reason: "repeated", checks: ["lint", "sast"] },
  },
  {
    name: "the same check failed, but not in a row",
    failing: ["lint"],
    earlier: [statuses({ lint: "success", test: "failure", sast: "success" }), {}, statuses({ lint: "failure", test: "success", sast: "success" })],
    expected: { kind: "fix", round: 3 },
  },
  {
    name: "the rounds are used up",
    failing: ["lint"],
    earlier: [statuses({ lint: "success", test: "failure", sast: "success" }), statuses({ lint: "success", test: "success", sast: "failure" }), statuses({ lint: "success", test: "failure", sast: "success" })],
    expected: { kind: "blocked", reason: "exhausted", rounds: 3 },
  },
  { name: "no fix round allowed", failing: ["lint"], earlier: [], rounds: 0, expected: { kind: "blocked", reason: "exhausted", rounds: 0 } },
  {
    name: "rounds from before the restart do not count",
    failing: ["lint"],
    earlier: [statuses({ lint: "failure", test: "success", sast: "success" }, BEFORE)],
    expected: { kind: "fix", round: 1 },
  },
];

for (const { name, failing, earlier, rounds, expected } of fixCases) {
  test(`fix loop: ${name}`, () => {
    assert.deepEqual(fixVerdict(failing, earlier, REQUIRED, rounds ?? 3, RETRY_AT), expected);
  });
}

const ciCases: { name: string; run: Parameters<typeof checkRunState>[0]; state: CheckState }[] = [
  { name: "queued", run: { status: "queued", conclusion: null }, state: "pending" },
  { name: "in progress", run: { status: "in_progress", conclusion: null }, state: "pending" },
  { name: "success", run: { status: "completed", conclusion: "success" }, state: "success" },
  { name: "skipped", run: { status: "completed", conclusion: "skipped" }, state: "error" },
  { name: "neutral", run: { status: "completed", conclusion: "neutral" }, state: "error" },
  { name: "failure", run: { status: "completed", conclusion: "failure" }, state: "failure" },
  { name: "timed out", run: { status: "completed", conclusion: "timed_out" }, state: "failure" },
  { name: "cancelled", run: { status: "completed", conclusion: "cancelled" }, state: "error" },
  { name: "action required", run: { status: "completed", conclusion: "action_required" }, state: "error" },
];
for (const { name, run, state } of ciCases) {
  test(`a check run that is ${name} counts as ${state}`, () => assert.equal(checkRunState(run), state));
}
