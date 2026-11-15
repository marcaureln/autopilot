import type { Host } from "./host.ts";

export type AllowEntry = { owner: string; repo?: string };

const ENTRY = /^([A-Za-z0-9-]+)(?:\/([A-Za-z0-9._-]+))?$/;

export function parseAllowEntry(value: string): AllowEntry {
  const match = ENTRY.exec(value);
  if (!match?.[1]) throw new Error(`"${value}" must be owner or owner/repo`);
  return match[2] ? { owner: match[1], repo: match[2] } : { owner: match[1] };
}

export function addAllowEntry(host: Host, value: string): Host {
  parseAllowEntry(value);
  return host.allow.includes(value) ? host : { ...host, allow: [...host.allow, value] };
}

export function removeAllowEntry(host: Host, value: string): Host {
  if (!host.allow.includes(value)) throw new Error(`${value} is not in the allowlist`);
  return { ...host, allow: host.allow.filter((entry) => entry !== value) };
}
