import { test } from "node:test";
import assert from "node:assert/strict";
import { planGate, mergeGate, type PlanGate, type MergeGate } from "./gate.ts";
import type { PlannerResult } from "./planner-result.ts";
import type { FileChange, Risk } from "./risk.ts";

const risk = { high_paths: ["src/billing-v2/**"], max_diff_lines: 500 };

const plan: PlannerResult = {
  needs_info: false,
  questions: [],
  scope: "ok",
  risk: "low",
  planned_files: [{ path: "CONTRIBUTING.md", status: "added" }],
  spec: "Add a guide.",
};

const cases: { name: string; result: Partial<PlannerResult>; expected: PlanGate }[] = [
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
    assert.deepEqual(planGate({ ...plan, ...result }, risk), expected);
  });
}

const contributing: FileChange[] = [{ status: "added", path: "CONTRIBUTING.md", additions: 20, deletions: 0 }];

const mergeGateCases: { name: string; changes?: FileChange[]; planner?: Risk; merge?: "auto" | "manual"; pushed?: boolean; base?: boolean; expected: MergeGate }[] = [
  { name: "low risk with auto merge merges", expected: { decision: "merge", rulesRisk: "low", reasons: [] } },
  { name: "manual merge asks for a review", merge: "manual", expected: { decision: "review", rulesRisk: "low", reasons: ["`merge` is `manual` in `.github/autopilot.json`"] } },
  {
    name: "a high-risk real diff asks for a review",
    changes: [...contributing, { status: "added", path: ".github/workflows/ci.yml", additions: 10, deletions: 0 }],
    expected: { decision: "review", rulesRisk: "high", reasons: ["the risk rules rate the diff high"] },
  },
  {
    name: "a diff larger than the limit asks for a review",
    changes: [{ status: "added", path: "docs/guide.md", additions: 600, deletions: 0 }],
    expected: { decision: "review", rulesRisk: "high", reasons: ["the risk rules rate the diff high"] },
  },
  { name: "the planner risk still counts", planner: "high", expected: { decision: "review", rulesRisk: "low", reasons: ["the planner rated the risk high"] } },
  { name: "a spec with no planner risk asks for a review", planner: undefined, expected: { decision: "review", rulesRisk: "low", reasons: ["the spec records no planner risk"] } },
  { name: "a head commit pushed by someone else asks for a review", pushed: false, expected: { decision: "review", rulesRisk: "low", reasons: ["autopilot did not push the head commit for this issue"] } },
  { name: "a pull request moved to another base asks for a review", base: false, expected: { decision: "review", rulesRisk: "low", reasons: ["the pull request does not target the default branch"] } },
];

for (const { name, changes, merge, pushed, base, expected, ...rest } of mergeGateCases) {
  test(`merge gate: ${name}`, () => {
    const planner = "planner" in rest ? rest.planner : "low";
    assert.deepEqual(mergeGate({ changes: changes ?? contributing, plannerRisk: planner, pushedByAutopilot: pushed ?? true, intoDefaultBranch: base ?? true }, { risk, merge: merge ?? "auto" }), expected);
  });
}
