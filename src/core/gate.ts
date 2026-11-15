import type { Config } from "./config.ts";
import type { PlannerResult } from "./planner.ts";
import { assessRisk, type FileChange, type Risk } from "./risk.ts";

export type Gate1 = { event: "needs_info" | "approval_required" | "go"; risk: Risk; rulesRisk: Risk };

function toChange(file: PlannerResult["planned_files"][number]): FileChange {
  return file.status === "renamed" ? { status: "renamed", path: file.path, previousPath: file.previous_path } : { status: file.status, path: file.path };
}

export function gate1(result: PlannerResult, risk: Config["risk"]): Gate1 {
  const rulesRisk = assessRisk(result.planned_files.map(toChange), risk);
  const finalRisk = result.risk === "high" || rulesRisk === "high" ? "high" : "low";
  const event = result.needs_info ? "needs_info" : result.scope === "too_broad" || finalRisk === "high" ? "approval_required" : "go";
  return { event, risk: finalRisk, rulesRisk };
}
