import { execFile } from "node:child_process";
import { addAllowEntry, parseAllowEntry, removeAllowEntry } from "../core/allow.ts";
import type { Client } from "../core/client.ts";
import type { Host } from "../core/host.ts";
import type { HostAccess } from "./host.ts";

async function requireHostFile(access: HostAccess): Promise<Host> {
  const host = await access.readHostFile();
  if (!host) throw new Error("the host has no host.json yet: run `autopilot host setup` first");
  return host;
}

async function installUrl(client: Client, owner: string): Promise<string> {
  const response = await fetch(`https://api.github.com/users/${owner}`, { headers: { accept: "application/vnd.github+json" } });
  if (!response.ok) throw new Error(`GitHub account ${owner} not found (${response.status})`);
  const account: unknown = await response.json();
  if (typeof account !== "object" || account === null || !("id" in account)) throw new Error(`unexpected answer for ${owner}`);
  return `https://github.com/apps/${client.app.slug}/installations/new/permissions?target_id=${String(account.id)}`;
}

function openInBrowser(url: string): void {
  execFile(process.platform === "darwin" ? "open" : "xdg-open", [url], () => {});
}

export async function allow(access: HostAccess, client: Client, value: string): Promise<void> {
  const { owner } = parseAllowEntry(value);
  const host = await requireHostFile(access);
  const url = await installUrl(client, owner);
  console.log(`Install or configure the App for ${owner}: ${url}`);
  openInBrowser(url);
  await access.writeHostFile(addAllowEntry(host, value));
  await access.restart();
  console.log(`allowed ${value}`);
}

export async function deny(access: HostAccess, value: string): Promise<void> {
  const host = await requireHostFile(access);
  await access.writeHostFile(removeAllowEntry(host, value));
  await access.restart();
  console.log(`denied ${value}`);
}

export async function listAllowed(access: HostAccess): Promise<void> {
  const host = await requireHostFile(access);
  console.log(host.allow.length > 0 ? host.allow.join("\n") : "(empty)");
}
