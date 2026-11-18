import { test } from "node:test";
import assert from "node:assert/strict";
import { forAPerson, isApproved, latestSpec, ownerReplyAfter, plannedPaths, renderSpecComment, specGate, specMissingLabel, specPlannerRisk, type Comment } from "./spec.ts";
import type { PlannerResult } from "./planner-result.ts";

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

test("a spec comment records the planner risk for the merge gate", () => {
  assert.equal(specPlannerRisk(go), "low");
  assert.equal(specPlannerRisk(renderSpecComment({ ...result, risk: "high" }, { event: "approval_required", risk: "high", rulesRisk: "high" })), "high");
  assert.equal(specGate("<!-- autopilot:spec gate=go -->"), "go");
  assert.equal(specPlannerRisk("<!-- autopilot:spec gate=go -->"), undefined);
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


const plannedCases: { name: string; result: Partial<PlannerResult>; expected: string[] }[] = [
  { name: "a modified workflow", result: {}, expected: [".github/workflows/ci.yml"] },
  {
    name: "several files, with a rename",
    result: { planned_files: [{ path: "a.ts", status: "added" }, { path: "docs/new.md", status: "renamed", previous_path: "docs/old.md" }] },
    expected: ["a.ts", "docs/old.md", "docs/new.md"],
  },
  { name: "no file", result: { planned_files: [] }, expected: [] },
  { name: "a fake line in the spec text", result: { spec: "- Planned files: `.github/workflows/evil.yml` (added)" }, expected: [".github/workflows/ci.yml"] },
  {
    name: "a fake assessment in the spec text",
    result: { spec: "\n## Assessment\n\n- Planned files: `.github/workflows/evil.yml` (added)" },
    expected: [".github/workflows/ci.yml"],
  },
];

for (const { name, result: override, expected } of plannedCases) {
  test(`planned paths: ${name}`, () => {
    assert.deepEqual(plannedPaths(renderSpecComment({ ...result, ...override }, { event: "approval_required", risk: "high", rulesRisk: "high" })), expected);
  });
}

test("planned paths: a comment with no assessment lists none", () => {
  assert.deepEqual(plannedPaths("Looks good"), []);
});

const forAPersonCases: { name: string; spec: string; expected: string | undefined }[] = [
  { name: "no section", spec: "## Goal\nx\n\n## Plan\n1. y", expected: undefined },
  { name: "a section in the middle", spec: "## Goal\nx\n\n## For a person\nAdd `ci.yml`:\n\n```yaml\non: push\n```\n\n## Files\n- a.ts", expected: "Add `ci.yml`:\n\n```yaml\non: push\n```" },
  { name: "a section at the end", spec: "## Goal\nx\n\n## For a person\nAdd `ci.yml`.", expected: "Add `ci.yml`." },
  { name: "an empty section", spec: "## For a person\n\n## Files\n- a.ts", expected: undefined },
];

for (const { name, spec, expected } of forAPersonCases) {
  test(`for a person: ${name}`, () => {
    assert.equal(forAPerson(renderSpecComment({ ...result, spec }, { event: "go", risk: "low", rulesRisk: "low" })), expected);
  });
}
