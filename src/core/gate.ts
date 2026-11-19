import type { Config } from "./config.ts";
import type { PlannerResult } from "./planner-result.ts";
import { assessRisk, type FileChange, type Risk } from "./risk.ts";

export type PlanGate = { event: "needs_info" | "approval_required" | "go"; risk: Risk; rulesRisk: Risk };

function toChange(file: PlannerResult["planned_files"][number]): FileChange {
  return file.status === "renamed" ? { status: "renamed", path: file.path, previousPath: file.previous_path } : { status: file.status, path: file.path };
}

export function planGate(result: PlannerResult, risk: Config["risk"]): PlanGate {
  const rulesRisk = assessRisk(result.planned_files.map(toChange), risk);
  const finalRisk = result.risk === "high" || rulesRisk === "high" ? "high" : "low";
  const event = result.needs_info ? "needs_info" : result.scope === "too_broad" || finalRisk === "high" ? "approval_required" : "go";
  return { event, risk: finalRisk, rulesRisk };
}

export type MergeGate = { decision: "merge" | "review"; rulesRisk: Risk; reasons: string[] };

export type MergeGateFacts = { changes: FileChange[]; plannerRisk: Risk | undefined; pushedByAutopilot: boolean; intoDefaultBranch: boolean };

export function mergeGate({ changes, plannerRisk, pushedByAutopilot, intoDefaultBranch }: MergeGateFacts, config: Pick<Config, "risk" | "merge">): MergeGate {
  const rulesRisk = assessRisk(changes, config.risk);
  const reasons = [
    ...(pushedByAutopilot ? [] : ["autopilot did not push the head commit for this issue"]),
    ...(intoDefaultBranch ? [] : ["the pull request does not target the default branch"]),
    ...(config.merge === "manual" ? ["`merge` is `manual` in `.github/autopilot.json`"] : []),
    ...(rulesRisk === "high" ? ["the risk rules rate the diff high"] : []),
    ...(plannerRisk === "high" ? ["the planner rated the risk high"] : []),
    ...(plannerRisk === undefined ? ["the spec records no planner risk"] : []),
  ];
  return { decision: reasons.length === 0 ? "merge" : "review", rulesRisk, reasons };
}
