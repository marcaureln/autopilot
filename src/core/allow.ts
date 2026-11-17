import type { Host } from "./host.ts";

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
  if (!host.allow.includes(value)) throw new Error(`${value} is not watched`);
  return { ...host, allow: host.allow.filter((entry) => entry !== value) };
}
