import type { Config } from "./config.ts";
import type { PlannerResult } from "./planner-result.ts";
import { assessRisk, workflowFiles, type FileChange, type Risk } from "./risk.ts";

export type PlanGate = { event: "needs_info" | "approval_required" | "done" | "go"; risk: Risk; rulesRisk: Risk };

function toChange(file: PlannerResult["planned_files"][number]): FileChange {
  return file.status === "renamed" ? { status: "renamed", path: file.path, previousPath: file.previous_path } : { status: file.status, path: file.path };
}

export function planGate(result: PlannerResult, risk: Config["risk"]): PlanGate {
  const changes = result.planned_files.map(toChange);
  const rulesRisk = assessRisk(changes, risk);
  const finalRisk = result.risk === "high" || rulesRisk === "high" ? "high" : "low";
  // A pushed workflow runs with the repo's Actions secrets before anyone reviews it, so a person approves it first.
  // Any other high risk goes to the build: the merge gate sends its pull request to a review, so a person looks once.
  const workflows = workflowFiles(changes.flatMap((change) => (change.status === "renamed" ? [change.path, change.previousPath] : [change.path])));
  const event = result.needs_info
    ? "needs_info"
    : result.scope === "too_broad" || workflows.length > 0
      ? "approval_required"
      : result.planned_files.length === 0
        ? "done"
        : "go";
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
