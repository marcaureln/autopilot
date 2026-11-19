import type { PlanGate } from "./gate.ts";

export type BotPull = {
  number: number;
  issue: number;
  state: "open" | "closed" | "merged";
  base: string;
  head: { ref: string; sha: string };
  closedAt: string | undefined;
};

export type Phase =
  | { kind: "spec" }
  | { kind: "plan"; event: "needs_info" | "approval_required" }
  | { kind: "build" }
  | { kind: "pull"; pull: BotPull }
  | { kind: "merged"; pull: BotPull }
  | { kind: "closed"; pull: BotPull };

const BRANCH = /^autopilot\/(\d+)-/;

export function branchName(issue: number, title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const short = slug.length > 40 ? slug.slice(0, 41).replace(/-[^-]*$/, "") : slug;
  return `autopilot/${issue}-${short || "change"}`;
}

// The branch name links a pull request to its issue: only the bot opens these pull requests, and
// nobody can change the head branch of an open one. The body can be edited by anyone with write access.
export function issueOfBranch(ref: string): number | undefined {
  const match = BRANCH.exec(ref);
  return match ? Number(match[1]) : undefined;
}

function after(a: string, b: string): boolean {
  return Date.parse(a) > Date.parse(b);
}

export function issuePhase(spec: { gate: PlanGate["event"]; buildAllowed: boolean } | undefined, pull: BotPull | undefined, retryAt: string): Phase {
  if (pull?.state === "open") return { kind: "pull", pull };
  if (pull?.closedAt && after(pull.closedAt, retryAt)) return pull.state === "merged" ? { kind: "merged", pull } : { kind: "closed", pull };
  if (!spec) return { kind: "spec" };
  if (spec.buildAllowed) return { kind: "build" };
  return { kind: "plan", event: spec.gate === "needs_info" ? "needs_info" : "approval_required" };
}

export function latestPull(pulls: BotPull[], issue: number): BotPull | undefined {
  return pulls.filter((pull) => pull.issue === issue).sort((a, b) => b.number - a.number)[0];
}

export type CheckState = "success" | "failure" | "error" | "pending";

type Status = { state: CheckState; description: string; at: string };

export type Statuses = Record<string, Status>;

// The epoch: in `ci` mode the CI results on a head count whenever they ran.
export const ANY_TIME = "1970-01-01T00:00:00Z";

// Only a success passes: a job that a change to the workflow skips must not open the merge gate. A
// skipped, cancelled or waiting run is not a code failure, so it counts as an error.
export function checkRunState(run: { status: string; conclusion: string | null }): CheckState {
  if (run.status !== "completed") return "pending";
  switch (run.conclusion) {
    case "success":
      return "success";
    case "failure":
    case "timed_out":
      return "failure";
    default:
      return "error";
  }
}

export type HeadVerdict = { kind: "run" } | { kind: "green" } | { kind: "failed"; failing: string[] };

export type FixVerdict =
  | { kind: "fix"; round: number }
  | { kind: "blocked"; reason: "exhausted"; rounds: number }
  | { kind: "blocked"; reason: "repeated"; checks: string[] };

function fresh(statuses: Statuses, retryAt: string): Statuses {
  return Object.fromEntries(Object.entries(statuses).filter(([, status]) => after(status.at, retryAt)));
}

function isFailed(status: Status | undefined): boolean {
  return status !== undefined && (status.state === "failure" || status.state === "error");
}

// A run that stopped before the end leaves a pending status, so the checks run again.
export function headVerdict(head: Statuses, required: string[], retryAt: string): HeadVerdict {
  const current = fresh(head, retryAt);
  if (required.some((check) => current[check] === undefined || current[check].state === "pending")) return { kind: "run" };
  const failing = required.filter((check) => isFailed(current[check]));
  return failing.length === 0 ? { kind: "green" } : { kind: "failed", failing };
}

// `earlier` holds the statuses of the commits before the head, newest first. Each checked commit
// before the head started one fix round.
export function fixVerdict(failing: string[], earlier: Statuses[], required: string[], fixRounds: number, retryAt: string): FixVerdict {
  const checked = earlier.map((statuses) => fresh(statuses, retryAt)).filter((statuses) => required.some((check) => statuses[check] && statuses[check].state !== "pending"));
  const previous = checked[0];
  const repeated = previous ? failing.filter((check) => isFailed(previous[check])) : [];
  if (repeated.length > 0) return { kind: "blocked", reason: "repeated", checks: repeated };
  if (checked.length >= fixRounds) return { kind: "blocked", reason: "exhausted", rounds: checked.length };
  return { kind: "fix", round: checked.length + 1 };
}
