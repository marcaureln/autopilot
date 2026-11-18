import type { Risk } from "./risk.ts";

type PlannedFile = { path: string; status: "added" | "modified" | "deleted" } | { path: string; status: "renamed"; previous_path: string };

export type PlannerResult = {
  needs_info: boolean;
  questions: string[];
  scope: "ok" | "too_broad";
  risk: Risk;
  planned_files: PlannedFile[];
  spec: string;
};
