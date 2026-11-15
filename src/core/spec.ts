import type { Gate1 } from "./gate.ts";
import type { PlannerResult } from "./planner.ts";

export type Comment = { id: number; nodeId: string; author: string; body: string; createdAt: string };

const MARKER = /^<!-- autopilot:spec gate=([a-z_]+) -->/;
const CHECKBOX = "Approve and build";

const NEXT_STEP: Record<Gate1["event"], string> = {
  needs_info: "Answer the questions in a comment. autopilot then writes a new spec.",
  approval_required: "Waits for approval. Tick the box below; only a tick by an owner counts.",
  go: "Building starts now.",
};

function fileLine(file: PlannerResult["planned_files"][number]): string {
  return file.status === "renamed" ? `\`${file.previous_path}\` → \`${file.path}\` (renamed)` : `\`${file.path}\` (${file.status})`;
}

export function renderSpecComment(result: PlannerResult, gate: Gate1): string {
  const riskLine = gate.risk === result.risk && gate.risk === gate.rulesRisk ? gate.risk : `${gate.risk} (planner: ${result.risk}, rules: ${gate.rulesRisk})`;
  const lines = [
    `<!-- autopilot:spec gate=${gate.event} -->`,
    result.spec.trim(),
    "",
    "## Assessment",
    "",
    `- Scope: ${result.scope === "ok" ? "ok" : "too broad"}`,
    `- Risk: ${riskLine}`,
    `- Planned files: ${result.planned_files.map(fileLine).join(", ") || "none"}`,
    `- Next: ${NEXT_STEP[gate.event]}`,
  ];
  if (gate.event === "needs_info") {
    lines.push("", "## Questions", "", ...result.questions.map((question, index) => `${index + 1}. ${question}`));
  }
  if (gate.event === "approval_required") lines.push("", `- [ ] ${CHECKBOX}`);
  return lines.join("\n");
}

const GATE_EVENTS: Gate1["event"][] = ["needs_info", "approval_required", "go"];

export function specGate(body: string): Gate1["event"] | undefined {
  const event = MARKER.exec(body)?.[1];
  return GATE_EVENTS.find((known) => known === event);
}

export function isApproved(body: string): boolean {
  const lastLine = body.trimEnd().split("\n").at(-1) ?? "";
  return new RegExp(`^- \\[[xX]\\] ${CHECKBOX}$`).test(lastLine.trim());
}

// GitHub has no record of who ticked a box, only of who edited the comment last.
export function isOwnerTick(body: string, lastEditor: string | undefined, owners: string[]): boolean {
  return isApproved(body) && lastEditor !== undefined && owners.includes(lastEditor);
}

export function latestSpec(comments: Comment[], botLogin: string): Comment | undefined {
  return comments.findLast((comment) => comment.author === botLogin && specGate(comment.body) !== undefined);
}

function after(a: string, b: string): boolean {
  return Date.parse(a) > Date.parse(b);
}

export function ownerReplyAfter(comments: Comment[], owners: string[], spec: Comment): Comment | undefined {
  return comments.find((comment) => owners.includes(comment.author) && after(comment.createdAt, spec.createdAt));
}

// A spec posted for this run of the trigger label, with no owner reply after it (a reply starts a new spec).
export function specMissingLabel(comments: Comment[], botLogin: string, owners: string[], labeledAt: string): Comment | undefined {
  const spec = latestSpec(comments, botLogin);
  if (!spec || !after(spec.createdAt, labeledAt) || ownerReplyAfter(comments, owners, spec)) return undefined;
  return spec;
}
