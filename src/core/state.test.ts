import { test } from "node:test";
import assert from "node:assert/strict";
import { labelsFor, migrateLabels, stateOf, transition, type Event, type IssueState } from "./state.ts";

const stateCases: { labels: string[]; expected: IssueState | "ambiguous" }[] = [
  { labels: ["autopilot"], expected: "new" },
  { labels: ["bug", "autopilot"], expected: "new" },
  { labels: ["autopilot", "autopilot:working"], expected: "working" },
  { labels: ["autopilot", "autopilot:needs-info", "bug"], expected: "needs-info" },
  { labels: ["autopilot", "autopilot:awaiting-approval"], expected: "awaiting-approval" },
  { labels: ["autopilot", "autopilot:blocked"], expected: "blocked" },
  { labels: ["autopilot", "autopilot:working", "autopilot:blocked"], expected: "ambiguous" },
  { labels: ["autopilot", "autopilot:unknown"], expected: "new" },
];

for (const { labels, expected } of stateCases) {
  test(`state of [${labels.join(", ")}] is ${expected}`, () => {
    assert.equal(stateOf(labels), expected);
  });
}

const transitionCases: { from: IssueState; event: Event; expected: IssueState | undefined }[] = [
  { from: "new", event: "start", expected: "working" },
  { from: "working", event: "needs_info", expected: "needs-info" },
  { from: "working", event: "approval_required", expected: "awaiting-approval" },
  { from: "working", event: "fail", expected: "blocked" },
  { from: "needs-info", event: "reply", expected: "working" },
  { from: "awaiting-approval", event: "approve", expected: "working" },

  { from: "new", event: "fail", expected: undefined },
  { from: "needs-info", event: "approve", expected: undefined },
  { from: "awaiting-approval", event: "fail", expected: undefined },
  { from: "working", event: "start", expected: undefined },
  { from: "blocked", event: "reply", expected: undefined },
];

for (const { from, event, expected } of transitionCases) {
  test(`${from} + ${event} -> ${expected ?? "not allowed"}`, () => {
    assert.equal(transition(from, event), expected);
  });
}

test("labelsFor keeps other labels and the trigger, and replaces the state label", () => {
  assert.deepEqual(labelsFor(["bug", "autopilot", "autopilot:working"], "blocked"), ["bug", "autopilot", "autopilot:blocked"]);
  assert.deepEqual(labelsFor(["autopilot"], "working"), ["autopilot", "autopilot:working"]);
});

const migrateCases: { labels: string[]; expected: string[] | undefined }[] = [
  { labels: ["autopilot", "autopilot:spec"], expected: ["autopilot", "autopilot:working"] },
  { labels: ["bug", "autopilot", "autopilot:building"], expected: ["bug", "autopilot", "autopilot:working"] },
  { labels: ["autopilot", "autopilot:checking"], expected: ["autopilot", "autopilot:working"] },
  { labels: ["autopilot", "autopilot:needs-review"], expected: ["autopilot", "autopilot:working"] },
  { labels: ["autopilot", "autopilot:building", "autopilot:working"], expected: ["autopilot", "autopilot:working"] },
  { labels: ["autopilot", "autopilot:needs-info"], expected: undefined },
  { labels: ["autopilot", "autopilot:working"], expected: undefined },
  { labels: ["spec"], expected: undefined },
];

for (const { labels, expected } of migrateCases) {
  test(`migrate [${labels.join(", ")}] -> ${expected ? `[${expected.join(", ")}]` : "unchanged"}`, () => {
    assert.deepEqual(migrateLabels(labels), expected);
  });
}
