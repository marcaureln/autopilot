import type { Host } from "./host.ts";
import { TRIGGER_LABEL } from "./state.ts";

export type WatchEntry = { owner: string; repo?: string };

export const WATCH_ENTRY = /^([A-Za-z0-9-]+)(?:\/([A-Za-z0-9._-]+))?$/;

export function parseWatchEntry(value: string): WatchEntry {
  const match = WATCH_ENTRY.exec(value);
  if (!match?.[1]) throw new Error(`"${value}" must be owner or owner/repo`);
  return match[2] ? { owner: match[1], repo: match[2] } : { owner: match[1] };
}

export function addWatchEntry(host: Host, value: string): Host {
  parseWatchEntry(value);
  return host.allow.includes(value) ? host : { ...host, allow: [...host.allow, value] };
}

export function removeWatchEntry(host: Host, value: string): Host {
  if (!host.allow.includes(value)) throw new Error(`the host does not watch ${value}`);
  return { ...host, allow: host.allow.filter((entry) => entry !== value) };
}

// One search covers every entry: GitHub ORs the user: and repo: qualifiers. user: also matches an
// organization.
export function searchQuery(state: "open" | "closed", entries: WatchEntry[]): string {
  const scopes = entries.map((entry) => (entry.repo ? `repo:${entry.owner}/${entry.repo}` : `user:${entry.owner}`));
  return [`label:${TRIGGER_LABEL}`, "is:issue", `is:${state}`, ...scopes].join(" ");
}
