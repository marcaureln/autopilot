import { renameSync, writeFileSync } from "node:fs";
import { addWatchEntry, parseWatchEntry, removeWatchEntry } from "../core/allow.ts";
import type { Audit } from "../core/audit.ts";
import { createGitHub } from "../core/github.ts";
import { HOST_FILE, loadHost, type Host } from "../core/host.ts";
import { readSecret } from "../core/secrets.ts";
import { restartService } from "./host.ts";

function writeHost(path: string, host: Host): void {
  writeFileSync(`${path}.tmp`, JSON.stringify(host, null, 2) + "\n", { mode: 0o644 });
  renameSync(`${path}.tmp`, path);
}

function restart(path: string): void {
  if (path !== HOST_FILE) return console.log("restart `autopilot start --foreground` to apply the change");
  restartService();
}

async function installUrl(slug: string, owner: string): Promise<string> {
  const response = await fetch(`https://api.github.com/users/${owner}`, { headers: { accept: "application/vnd.github+json" } });
  if (!response.ok) throw new Error(`GitHub account ${owner} not found (${response.status})`);
  const account: unknown = await response.json();
  if (typeof account !== "object" || account === null || !("id" in account)) throw new Error(`unexpected answer for ${owner}`);
  return `https://github.com/apps/${slug}/installations/new/permissions?target_id=${String(account.id)}`;
}

export async function watch(path: string, value: string, audit: Audit): Promise<void> {
  const entry = parseWatchEntry(value);
  const host = loadHost(path);
  const github = createGitHub({ appId: host.app_id, privateKey: readSecret(host.secrets.app_key, "watch: check the App installation", audit) }, audit);
  if ((await github.findInstallation(entry)) === undefined) {
    console.log(`The App is not installed for ${value}. Install it. The host starts to poll it at the next loop.`);
    console.log(`open: ${await installUrl(await github.appSlug(), entry.owner)}`);
  }
  if (host.allow.includes(value)) return console.log(`${host.name} already watches ${value}`);
  writeHost(path, addWatchEntry(host, value));
  audit({ event: "allowlist.changed", action: "watch", entry: value, by: process.env.SUDO_USER });
  restart(path);
  console.log(`${host.name} watches ${value}`);
}

export function unwatch(path: string, value: string, audit: Audit): void {
  const host = loadHost(path);
  writeHost(path, removeWatchEntry(host, value));
  audit({ event: "allowlist.changed", action: "unwatch", entry: value, by: process.env.SUDO_USER });
  restart(path);
  console.log(`${host.name} no longer watches ${value}`);
}

export function watched(path: string): void {
  const host = loadHost(path);
  console.log(`${host.name}: ${host.allow.join(", ") || "(empty)"}`);
}
