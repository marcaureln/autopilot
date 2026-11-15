import { spawnSync } from "node:child_process";
import type { Gate1, Gate2 } from "./gate.ts";
import type { Risk } from "./risk.ts";
import type { IssueState, State } from "./state.ts";

// Values never go into an event, only names and references.
export type AuditEvent =
  | { event: "secret.read"; reference: string; reason: string; result: "ok" | "failed" }
  | { event: "token.minted"; installation: number; repo: string; expires: string }
  | { event: "issue.claimed"; issue: string; host: string }
  | { event: "state.changed"; issue: string; from: IssueState; to: State }
  | { event: "gate.decided"; issue: string; gate: "gate1"; planner: Risk; rules: Risk; final: Risk; scope: "ok" | "too_broad"; decision: Gate1["event"] }
  | { event: "gate.decided"; issue: string; gate: "gate2"; pull: number; planner: Risk | undefined; rules: Risk; merge: "auto" | "manual"; decision: Gate2["decision"] }
  | { event: "checks.ran"; issue: string; pull: number; sha: string; results: Record<string, string> }
  | { event: "git.pushed"; repo: string; branch: string; head: string; base: string; commits: number; force: boolean }
  | { event: "pr.opened"; repo: string; pull: number; issue: number; branch: string }
  | { event: "pr.merged"; repo: string; pull: number; sha: string }
  | { event: "review.requested"; repo: string; pull: number; reviewers: string[] }
  | { event: "approval.accepted" | "approval.refused"; issue: string; editors: string[] }
  | { event: "container.started"; name: string; image: string; mounts: string[]; env: string[]; caps: Record<string, string | number> }
  | { event: "container.ended"; name: string; exit: number; timed_out: boolean; duration_seconds: number }
  | { event: "allowlist.changed"; action: "allow" | "deny"; entry: string; by: string | undefined };

export type Audit = (event: AuditEvent) => void;

export const AUDIT_TAG = "autopilot-audit";

function line(event: AuditEvent): string {
  return JSON.stringify({ at: new Date().toISOString(), ...event });
}

// Synchronous on purpose: a lost audit line fails the action.
function journal(event: AuditEvent): void {
  const result = spawnSync("systemd-cat", ["--identifier", AUDIT_TAG], { input: `${line(event)}\n` });
  if (result.status !== 0) throw new Error(`audit: systemd-cat failed (${result.error?.message ?? `exit ${result.status}`})`);
}

export const auditLog: Audit = process.platform === "linux" ? journal : (event) => console.error(`audit ${line(event)}`);
