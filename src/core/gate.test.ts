import { test } from "node:test";
import assert from "node:assert/strict";
import { gate1, type Gate1 } from "./gate.ts";
import type { PlannerResult } from "./planner.ts";

const risk = { high_paths: ["src/billing-v2/**"], max_diff_lines: 500 };

const plan: PlannerResult = {
  needs_info: false,
  questions: [],
  scope: "ok",
  risk: "low",
  planned_files: [{ path: "CONTRIBUTING.md", status: "added" }],
  spec: "Add a guide.",
};

const cases: { name: string; result: Partial<PlannerResult>; expected: Gate1 }[] = [
  { name: "clear, small and low risk goes", result: {}, expected: { event: "go", risk: "low", rulesRisk: "low" } },
  { name: "questions come first", result: { needs_info: true, questions: ["Which file?"], scope: "too_broad", risk: "high" }, expected: { event: "needs_info", risk: "high", rulesRisk: "low" } },
  { name: "too broad needs approval", result: { scope: "too_broad" }, expected: { event: "approval_required", risk: "low", rulesRisk: "low" } },
  { name: "the planner can raise the risk", result: { risk: "high" }, expected: { event: "approval_required", risk: "high", rulesRisk: "low" } },
  {
    name: "the planner cannot lower the rules risk",
    result: { risk: "low", planned_files: [{ path: ".github/workflows/ci.yml", status: "modified" }] },
    expected: { event: "approval_required", risk: "high", rulesRisk: "high" },
  },
  {
    name: "the repo's own high paths count",
    result: { planned_files: [{ path: "src/billing-v2/plan.ts", status: "modified" }] },
    expected: { event: "approval_required", risk: "high", rulesRisk: "high" },
  },
  {
    name: "a planned deletion is high risk",
    result: { planned_files: [{ path: "docs/old.md", status: "deleted" }] },
    expected: { event: "approval_required", risk: "high", rulesRisk: "high" },
  },
  {
    name: "a plain rename is low risk",
    result: { planned_files: [{ path: "docs/new.md", status: "renamed", previous_path: "docs/old.md" }] },
    expected: { event: "go", risk: "low", rulesRisk: "low" },
  },
];

for (const { name, result, expected } of cases) {
  test(name, () => {
    assert.deepEqual(gate1({ ...plan, ...result }, risk), expected);
  });
}
