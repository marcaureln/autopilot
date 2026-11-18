import { test } from "node:test";
import assert from "node:assert/strict";
import { parsePlannerResult, plannerPrompt } from "./planner.ts";

const valid = {
  needs_info: false,
  questions: [],
  scope: "ok",
  risk: "low",
  planned_files: [
    { path: "CONTRIBUTING.md", status: "added" },
    { path: "docs/b.md", status: "renamed", previous_path: "docs/a.md" },
  ],
  spec: "## Goal\nAdd a guide.",
};

test("accepts a valid result", () => {
  assert.deepEqual(parsePlannerResult(JSON.stringify(valid)), valid);
});

const invalid: { name: string; text: string; error: RegExp }[] = [
  { name: "not JSON", text: "Done!", error: /not valid JSON/ },
  { name: "needs_info without questions", text: JSON.stringify({ ...valid, needs_info: true }), error: /questions/ },
  { name: "unknown risk", text: JSON.stringify({ ...valid, risk: "medium" }), error: /risk/ },
  { name: "rename without previous path", text: JSON.stringify({ ...valid, planned_files: [{ path: "b.md", status: "renamed" }] }), error: /planned_files/ },
  { name: "empty spec", text: JSON.stringify({ ...valid, spec: "" }), error: /spec/ },
  { name: "extra field", text: JSON.stringify({ ...valid, approved: true }), error: /additional/ },
];

for (const { name, text, error } of invalid) {
  test(`rejects ${name}`, () => {
    assert.throws(() => parsePlannerResult(text), error);
  });
}

const promptCases: { workflows: boolean; forAPerson: boolean }[] = [
  { workflows: false, forAPerson: true },
  { workflows: true, forAPerson: false },
];

for (const { workflows, forAPerson } of promptCases) {
  test(`the planner prompt ${forAPerson ? "has" : "has no"} "For a person" section when the Workflows permission is ${workflows ? "there" : "missing"}`, () => {
    const prompt = plannerPrompt({ repo: "o/r", issue: { number: 7, title: "t", body: "" }, thread: [], risk: { max_diff_lines: 400, high_paths: [] }, canChangeWorkflows: workflows });
    assert.equal(prompt.includes("## For a person"), forAPerson);
    assert.match(prompt, /one line on why\.\n   - A Mermaid diagram only when it makes the flow clearer\.\n(   - .*\n)?   When `needs_info` is true/);
  });
}
