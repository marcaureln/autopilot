import { test } from "node:test";
import assert from "node:assert/strict";
import { labelsFor, stateOf, transition, type Event, type IssueState } from "./state.ts";

const stateCases: { labels: string[]; expected: IssueState | "ambiguous" }[] = [
  { labels: ["autopilot"], expected: "new" },
  { labels: ["bug", "autopilot"], expected: "new" },
  { labels: ["autopilot", "autopilot:spec"], expected: "spec" },
  { labels: ["autopilot", "autopilot:needs-info", "bug"], expected: "needs-info" },
  { labels: ["autopilot", "autopilot:awaiting-approval"], expected: "awaiting-approval" },
  { labels: ["autopilot", "autopilot:building"], expected: "building" },
  { labels: ["autopilot", "autopilot:blocked"], expected: "blocked" },
  { labels: ["autopilot", "autopilot:spec", "autopilot:building"], expected: "ambiguous" },
  { labels: ["autopilot", "autopilot:unknown"], expected: "new" },
];

for (const { labels, expected } of stateCases) {
  test(`state of [${labels.join(", ")}] is ${expected}`, () => {
    assert.equal(stateOf(labels), expected);
  });
}

const transitionCases: { from: IssueState; event: Event; expected: IssueState | undefined }[] = [
  { from: "new", event: "start", expected: "spec" },
  { from: "spec", event: "needs_info", expected: "needs-info" },
  { from: "spec", event: "approval_required", expected: "awaiting-approval" },
  { from: "spec", event: "go", expected: "building" },
  { from: "spec", event: "fail", expected: "blocked" },
  { from: "needs-info", event: "reply", expected: "spec" },
  { from: "awaiting-approval", event: "approve", expected: "building" },

  { from: "new", event: "go", expected: undefined },
  { from: "needs-info", event: "approve", expected: undefined },
  { from: "awaiting-approval", event: "go", expected: undefined },
  { from: "building", event: "start", expected: undefined },
  { from: "blocked", event: "reply", expected: undefined },
];

for (const { from, event, expected } of transitionCases) {
  test(`${from} + ${event} -> ${expected ?? "not allowed"}`, () => {
    assert.equal(transition(from, event), expected);
  });
}

test("labelsFor keeps other labels and the trigger, and replaces the state label", () => {
  assert.deepEqual(labelsFor(["bug", "autopilot", "autopilot:spec"], "building"), ["bug", "autopilot", "autopilot:building"]);
  assert.deepEqual(labelsFor(["autopilot"], "spec"), ["autopilot", "autopilot:spec"]);
});
