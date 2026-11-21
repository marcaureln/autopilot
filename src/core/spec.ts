import type { PlanGate } from "./gate.ts";
import type { PlannerResult } from "./planner-result.ts";
import type { Risk } from "./risk.ts";

export type Comment = { id: number; nodeId: string; author: string; body: string; createdAt: string };

// Older spec comments have no planner risk.
const MARKER = /^<!-- autopilot:spec gate=([a-z_]+)(?: planner=(low|high))? -->/;
const CHECKBOX = "Approve and build";

const NEXT_STEP: Record<PlanGate["event"], string> = {
  needs_info: "Answer the questions in a comment. autopilot then writes a new spec.",
  approval_required: "autopilot waits for approval. Tick the box below. Only a tick by an owner counts.",
  done: "Nothing to change, so autopilot closes this issue. If something is still missing, say what in a comment, then reopen the issue and add the label again.",
  go: "The build starts now.",
};

// A reviewer reads these sections first. Every other section of the spec is folded.
const OPEN_SECTIONS = new Set(["goal", "plan", "for a person"]);

function escapeHtml(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

export function foldSections(markdown: string): string {
  const sections: { title: string | undefined; lines: string[] }[] = [{ title: undefined, lines: [] }];
  let fence: string | undefined;
  for (const line of markdown.split("\n")) {
    const marker = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
    if (marker && (fence === undefined || marker.startsWith(fence))) fence = fence === undefined ? marker : undefined;
    if (fence === undefined && line.startsWith("## ")) sections.push({ title: line.slice(3).trim(), lines: [line] });
    else sections.at(-1)?.lines.push(line);
  }
  return sections
    .map(({ title, lines }) => {
      const text = lines.join("\n").trim();
      if (title === undefined || OPEN_SECTIONS.has(title.toLowerCase())) return text;
      return `<details><summary>${escapeHtml(title)}</summary>\n\n${lines.slice(1).join("\n").trim()}\n\n</details>`;
    })
    .filter((text) => text !== "")
    .join("\n\n");
}

function fileLine(file: PlannerResult["planned_files"][number]): string {
  return file.status === "renamed" ? `\`${file.previous_path}\` → \`${file.path}\` (renamed)` : `\`${file.path}\` (${file.status})`;
}

export function renderSpecComment(result: PlannerResult, gate: PlanGate): string {
  const riskLine = gate.risk === result.risk && gate.risk === gate.rulesRisk ? gate.risk : `${gate.risk} (planner: ${result.risk}, rules: ${gate.rulesRisk})`;
  const lines = [
    `<!-- autopilot:spec gate=${gate.event} planner=${result.risk} -->`,
    foldSections(result.spec),
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

const GATE_EVENTS: PlanGate["event"][] = ["needs_info", "approval_required", "done", "go"];

export function specGate(body: string): PlanGate["event"] | undefined {
  const event = MARKER.exec(body)?.[1];
  return GATE_EVENTS.find((known) => known === event);
}

export function specPlannerRisk(body: string): Risk | undefined {
  const risk = MARKER.exec(body)?.[2];
  return risk === "low" || risk === "high" ? risk : undefined;
}

// Only the last line counts: a box inside the text above it cannot pass for the real one.
export function isTicked(body: string, checkbox: string): boolean {
  const lastLine = body.trimEnd().split("\n").at(-1) ?? "";
  return new RegExp(`^- \\[[xX]\\] ${checkbox}$`).test(lastLine.trim());
}

export function isApproved(body: string): boolean {
  return isTicked(body, CHECKBOX);
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

const ASSESSMENT = "\n## Assessment\n";

// The assessment is the last part of a spec comment, so text in the spec cannot replace it.
export function plannedPaths(body: string): string[] {
  const start = body.lastIndexOf(ASSESSMENT);
  if (start === -1) return [];
  const line = body.slice(start).split("\n").find((candidate) => candidate.startsWith("- Planned files: "));
  return [...(line ?? "").matchAll(/`([^`]+)`/g)].flatMap((match) => (match[1] === undefined ? [] : [match[1]]));
}

// The planner's `## For a person` section: the changes that autopilot cannot push.
export function forAPerson(body: string): string | undefined {
  const end = body.lastIndexOf(ASSESSMENT);
  const lines = (end === -1 ? body : body.slice(0, end)).split("\n");
  const start = lines.indexOf("## For a person");
  if (start === -1) return undefined;
  const rest = lines.slice(start + 1);
  const next = rest.findIndex((line) => line.startsWith("## ") || line.startsWith("<details>"));
  const section = (next === -1 ? rest : rest.slice(0, next)).join("\n").trim();
  return section === "" ? undefined : section;
}
