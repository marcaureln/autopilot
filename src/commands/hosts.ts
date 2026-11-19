import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_DIR } from "../core/config-dir.ts";
import { defaultHostName } from "../core/host.ts";
import { addHost, checkHost, HOSTS_SCHEMA, nameOfTarget, nameProblem, NO_HOSTS, parseHosts, removeHost, resolveHost, setDefaultHost, type HostRef, type HostsFile } from "../core/hosts.ts";
import { hostSetup, type HostSetupOptions } from "./client.ts";

export const HOSTS_PATH = join(CONFIG_DIR, "hosts.json");

export const HOSTS_USAGE = "usage: autopilot hosts [add <name> <ssh-target | local> | rm <name> | default <name>]";

export function loadHosts(dropUnknownDefault = false): HostsFile {
  return existsSync(HOSTS_PATH) ? parseHosts(readFileSync(HOSTS_PATH, "utf8"), HOSTS_PATH, dropUnknownDefault) : NO_HOSTS;
}

function saveHosts(file: HostsFile): void {
  mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  const text = JSON.stringify({ $schema: HOSTS_SCHEMA, default: file.default, hosts: file.hosts }, null, 2) + "\n";
  const tmp = `${HOSTS_PATH}.${process.pid}.tmp`;
  writeFileSync(tmp, text, { flag: "wx" });
  renameSync(tmp, HOSTS_PATH);
}

export function findHost(flag: string | undefined, env: string | undefined): HostRef | undefined {
  const forwardedUnderSudo = process.env.SUDO_USER !== undefined;
  return resolveHost(flag, env, () => (forwardedUnderSudo ? NO_HOSTS : loadHosts()));
}

export function checkHostName(host: HostRef, given: string | undefined): void {
  nameToSave(host, given);
}

export function nameToSave(host: HostRef, given: string | undefined): string {
  const name = given ?? host.savedName ?? nameOfTarget(loadHosts(), host.target, defaultHostName());
  const problem = nameProblem(name);
  if (problem) throw new Error(`${problem}. Name the host with --name <name>`);
  return name;
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

function checkHostsFile(): void {
  loadHosts(true);
}

export async function hostsAdd(name: string, target: string, options: HostSetupOptions): Promise<void> {
  checkHost(name, target);
  checkHostsFile();
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
