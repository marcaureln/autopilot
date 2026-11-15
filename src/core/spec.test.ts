import { test } from "node:test";
import assert from "node:assert/strict";
import { isApproved, latestSpec, ownerReplyAfter, renderSpecComment, specGate, specMissingLabel, type Comment } from "./spec.ts";
import type { PlannerResult } from "./planner.ts";

const BOT = "autopilot[bot]";
const OWNERS = ["marcaureln"];

const result: PlannerResult = {
  needs_info: false,
  questions: [],
  scope: "ok",
  risk: "low",
  planned_files: [{ path: ".github/workflows/ci.yml", status: "modified" }],
  spec: "## Goal\nRun CI on tags.",
};

function comment(id: number, author: string, body: string, minute: number): Comment {
  return { id, nodeId: `C${id}`, author, body, createdAt: `2026-11-15T10:${String(minute).padStart(2, "0")}:00Z` };
}

const approval = renderSpecComment(result, { event: "approval_required", risk: "high", rulesRisk: "high" });
const questions = renderSpecComment({ ...result, needs_info: true, questions: ["Which tags?"] }, { event: "needs_info", risk: "high", rulesRisk: "high" });
const go = renderSpecComment(result, { event: "go", risk: "low", rulesRisk: "low" });

test("a spec comment records the gate decision", () => {
  assert.equal(specGate(approval), "approval_required");
  assert.equal(specGate(questions), "needs_info");
  assert.equal(specGate(go), "go");
  assert.equal(specGate("<!-- autopilot:spec gate=merge -->"), undefined);
  assert.equal(specGate("Looks good"), undefined);
});

test("only an approval spec has the checkbox, and it ends the comment", () => {
  assert.match(approval, /\n- \[ \] Approve and build$/);
  assert.doesNotMatch(go, /Approve and build/);
  assert.doesNotMatch(questions, /Approve and build/);
  assert.match(questions, /1\. Which tags\?/);
});

const approvedCases: { name: string; body: string; expected: boolean }[] = [
  { name: "unticked", body: approval, expected: false },
  { name: "ticked", body: approval.replace("- [ ] Approve and build", "- [x] Approve and build"), expected: true },
  { name: "ticked upper case", body: approval.replace("- [ ] Approve and build", "- [X] Approve and build"), expected: true },
  { name: "ticked box inside the spec text only", body: `- [x] Approve and build\n${approval}`, expected: false },
  { name: "trailing newline after the tick", body: `${approval.replace("[ ]", "[x]")}\n`, expected: true },
];

for (const { name, body, expected } of approvedCases) {
  test(`approval: ${name}`, () => {
    assert.equal(isApproved(body), expected);
  });
}

const thread = [
  comment(1, "marcaureln", "Please do it", 1),
  comment(2, BOT, questions, 2),
  comment(3, "stranger", "I want this too", 3),
  comment(4, "marcaureln", "Only v* tags", 4),
  comment(5, BOT, "Some other bot note", 5),
];

test("latestSpec finds the last spec comment by the bot", () => {
  assert.equal(latestSpec(thread, BOT)?.id, 2);
  assert.equal(latestSpec([...thread, comment(6, "marcaureln", approval, 6)], BOT)?.id, 2);
  assert.equal(latestSpec([], BOT), undefined);
});

test("ownerReplyAfter ignores non-owners and comments before the spec", () => {
  const spec = latestSpec(thread, BOT);
  assert.ok(spec);
  assert.equal(ownerReplyAfter(thread, OWNERS, spec)?.id, 4);
  assert.equal(ownerReplyAfter(thread.slice(0, 3), OWNERS, spec), undefined);
});

const missingLabelCases: { name: string; comments: Comment[]; labeledAt: string; expected: number | undefined }[] = [
  { name: "no spec yet", comments: [comment(1, "marcaureln", "hi", 1)], labeledAt: "2026-11-15T10:00:00Z", expected: undefined },
  { name: "spec after the label and no reply", comments: [comment(2, BOT, go, 2)], labeledAt: "2026-11-15T10:00:00Z", expected: 2 },
  { name: "spec from before the label was added again", comments: [comment(2, BOT, go, 2)], labeledAt: "2026-11-15T10:03:00Z", expected: undefined },
  { name: "an owner replied after the spec", comments: thread, labeledAt: "2026-11-15T10:00:00Z", expected: undefined },
  { name: "a non-owner reply does not count", comments: thread.slice(0, 3), labeledAt: "2026-11-15T10:00:00Z", expected: 2 },
];

for (const { name, comments, labeledAt, expected } of missingLabelCases) {
  test(`specMissingLabel: ${name}`, () => {
    assert.equal(specMissingLabel(comments, BOT, OWNERS, labeledAt)?.id, expected);
  });
}

