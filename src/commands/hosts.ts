import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { defaultHostName } from "../core/host.ts";
import { addHost, checkHost, HOSTS_SCHEMA, nameOfTarget, NO_HOSTS, parseHosts, removeHost, resolveHost, setDefaultHost, type HostRef, type HostsFile } from "../core/hosts.ts";
import { hostSetup, type HostSetupOptions } from "./client.ts";

// The XDG spec says to ignore a relative XDG_CONFIG_HOME.
const xdgConfigHome = process.env.XDG_CONFIG_HOME;
export const HOSTS_PATH = join(xdgConfigHome && isAbsolute(xdgConfigHome) ? xdgConfigHome : join(homedir(), ".config"), "autopilot", "hosts.json");

export const HOSTS_USAGE = "usage: autopilot hosts [add <name> <ssh-target | local> | rm <name> | default <name>]";

function loadHosts(repair = false): HostsFile {
  return existsSync(HOSTS_PATH) ? parseHosts(readFileSync(HOSTS_PATH, "utf8"), HOSTS_PATH, repair) : NO_HOSTS;
}

function saveHosts(file: HostsFile): void {
  mkdirSync(dirname(HOSTS_PATH), { recursive: true });
  const text = JSON.stringify({ $schema: HOSTS_SCHEMA, default: file.default, hosts: file.hosts }, null, 2) + "\n";
  writeFileSync(`${HOSTS_PATH}.tmp`, text);
  renameSync(`${HOSTS_PATH}.tmp`, HOSTS_PATH);
}

// A forwarded command runs under sudo on a Linux host, which is not where the client keeps its hosts file.
export function findHost(flag: string | undefined, env: string | undefined): HostRef | undefined {
  return resolveHost(flag, env, () => (process.env.SUDO_USER ? NO_HOSTS : loadHosts()));
}

export function hostName(host: HostRef): string {
  return host.savedName ?? nameOfTarget(loadHosts(), host.target, defaultHostName());
}

export function saveHost(name: string, target: string): { changed: boolean; isDefault: boolean } {
  const file = loadHosts(true);
  const next = addHost(file, name, target);
  const changed = JSON.stringify(next) !== JSON.stringify(file);
  if (changed) saveHosts(next);
  return { changed, isDefault: next.default === name };
}

export function listHosts(): void {
  const file = loadHosts();
  const names = Object.keys(file.hosts);
  if (names.length === 0) return console.log("No host yet. Add one with autopilot hosts add <name> <ssh-target | local>.");
  const nameWidth = Math.max(...names.map((name) => name.length));
  const targetWidth = Math.max(...Object.values(file.hosts).map((host) => host.target.length));
  for (const [name, { target }] of Object.entries(file.hosts)) {
    console.log(`${name.padEnd(nameWidth)}  ${target.padEnd(targetWidth)}  ${name === file.default ? "default" : ""}`.trimEnd());
  }
}

export async function hostsAdd(name: string, target: string, options: HostSetupOptions): Promise<void> {
  checkHost(name, target);
  // A file that cannot be saved must fail before the host work, not after it.
  loadHosts(true);
  await hostSetup(target, options);
  const { isDefault } = saveHost(name, target);
  console.log(`==> saved ${name} (${target}) in ${HOSTS_PATH}${isDefault ? ". It is the default host" : ""}`);
}

export function hostsRemove(name: string): void {
  const file = loadHosts(true);
  saveHosts(removeHost(file, name));
  console.log(`Removed ${name} from ${HOSTS_PATH}. This does not uninstall autopilot on the host: its service, release and secrets stay.`);
  if (file.default === name) console.log("There is no default host now. Set one with autopilot hosts default <name>.");
}

export function hostsDefault(name: string): void {
  saveHosts(setDefaultHost(loadHosts(true), name));
  console.log(`${name} is the default host.`);
}
