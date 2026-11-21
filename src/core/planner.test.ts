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

const pathCases: { name: string; path: string; clean: boolean }[] = [
  { name: "a plain path", path: "src/a.ts", clean: true },
  { name: "a workflow path", path: ".github/workflows/ci.yml", clean: true },
  { name: "a backtick", path: "a` `.github/workflows/x.yml", clean: false },
  { name: "a newline", path: "a\n.github/workflows/x.yml", clean: false },
  { name: "a control character", path: "a\u0000b", clean: false },
  { name: "an absolute path", path: "/etc/passwd", clean: false },
  { name: "a parent segment", path: "src/../.github/workflows/x.yml", clean: false },
  { name: "a dots name", path: "src/..a/b", clean: true },
];

for (const { name, path, clean } of pathCases) {
  test(`planned path: ${name}`, () => {
    const files = [{ path, status: "added" }];
    const parse = () => parsePlannerResult(JSON.stringify({ ...valid, planned_files: files }));
    if (clean) assert.doesNotThrow(parse);
    else assert.throws(parse, /not a clean relative path/);
  });
}

test("rejects an unclean previous path", () => {
  const files = [{ path: "b.md", status: "renamed", previous_path: "a`.md" }];
  assert.throws(() => parsePlannerResult(JSON.stringify({ ...valid, planned_files: files })), /not a clean relative path/);
});

const promptCases: { workflows: boolean; forAPerson: boolean }[] = [
  { workflows: false, forAPerson: true },
  { workflows: true, forAPerson: false },
];

for (const { workflows, forAPerson } of promptCases) {
  test(`the planner prompt ${forAPerson ? "has" : "has no"} "For a person" section when the Workflows permission is ${workflows ? "there" : "missing"}`, () => {
    const prompt = plannerPrompt({ repo: "o/r", issue: { number: 7, title: "t", body: "" }, thread: [], risk: { max_diff_lines: 400, high_paths: [] }, canChangeWorkflows: workflows });
    assert.equal(prompt.includes("## For a person"), forAPerson);
    assert.match(prompt, /one line on why\.\n   - A Mermaid diagram only when it makes the flow clearer\.\n   - Other `##` sections.*\n(   - .*\n)?   When `needs_info` is true/);
  });
}
