import { execFile, execFileSync } from "node:child_process";
import { addAllowEntry, overlaps, parseAllowEntry, removeAllowEntry } from "../core/allow.ts";
import type { Client } from "../core/client.ts";
import { createGitHub } from "../core/github.ts";
import type { Host } from "../core/host.ts";
import type { HostAccess } from "./host.ts";

export type Hosts = Map<string, HostAccess>;

async function requireHostFile(name: string, access: HostAccess): Promise<Host> {
  const host = await access.readHostFile();
  if (!host) throw new Error(`host ${name} has no host.json yet: run \`autopilot host setup --on ${name}\` first`);
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

export async function allow(hosts: Hosts, target: string, client: Client, value: string): Promise<void> {
  const entry = parseAllowEntry(value);
  const access = hosts.get(target);
  if (!access) throw new Error(`unknown host ${target}`);
  const host = await requireHostFile(target, access);

  for (const [name, other] of hosts) {
    if (name === target) continue;
    const taken = (await other.readHostFile())?.allow.find((existing) => overlaps(entry, parseAllowEntry(existing)));
    if (taken) throw new Error(`${value} overlaps ${taken} on host ${name}: two hosts would build the same issues`);
  }

  const privateKey = execFileSync("op", ["document", "get", "github-app-private-key", "--vault", "autopilot"], { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
  if ((await createGitHub({ appId: client.app.id, privateKey }).findInstallation(entry)) === undefined) {
    const url = await installUrl(client, entry.owner);
    console.log(`The App is not installed for ${value}. Install it: ${url}`);
    openInBrowser(url);
  }

  await access.writeHostFile(addAllowEntry(host, value));
  await access.restart();
  console.log(`allowed ${value} on ${target}`);
}

export async function deny(hosts: Hosts, target: string, value: string): Promise<void> {
  const access = hosts.get(target);
  if (!access) throw new Error(`unknown host ${target}`);
  const host = await requireHostFile(target, access);
  await access.writeHostFile(removeAllowEntry(host, value));
  await access.restart();
  console.log(`denied ${value} on ${target}`);
}

export async function listAllowed(hosts: Hosts): Promise<void> {
  for (const [name, access] of hosts) {
    const host = await access.readHostFile();
    console.log(`${name}: ${host ? host.allow.join(", ") || "(empty)" : "(not set up)"}`);
  }
}
