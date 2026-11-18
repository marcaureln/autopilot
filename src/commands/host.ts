import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, readlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { AUDIT_TAG } from "../core/audit.ts";
import { loadHost, type Host } from "../core/host.ts";
import { LOCAL_TARGET } from "../core/hosts.ts";
import { hostLayout, LOCAL_LAYOUT, parseOS, type Layout } from "../core/layout.ts";
import { RELEASE_TAG } from "../core/setup.ts";

const RELEASE_REPO = "marcaureln/autopilot";
// scripts/setup.sh and scripts/setup-macos.sh give the systemd unit and the launchd job this name.
export const SERVICE = "autopilot";

export type Release = { kind: "github"; tag: string } | { kind: "checkout"; commit: string; archive: () => Buffer };

export type Shell = {
  run(command: string, input?: Buffer): Promise<number>;
  capture(command: string): Promise<{ code: number; stdout: string }>;
};

export type Connection = { shell: Shell; layout: Layout; sudo: string; name: string };

function shellThrough(program: string, args: string[]): Shell {
  function exec(command: string, input: Buffer | undefined, capture: boolean): Promise<{ code: number; stdout: string }> {
    return new Promise((resolve, reject) => {
      const child = spawn(program, [...args, command], { stdio: ["pipe", capture ? "pipe" : "inherit", "inherit"] });
      let stdout = "";
      child.stdout?.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
      child.on("error", reject);
      child.on("close", (code) => resolve({ code: code ?? 1, stdout }));
      child.stdin?.end(input);
    });
  }
  return {
    run: async (command, input) => (await exec(command, input, false)).code,
    capture: (command) => exec(command, undefined, true),
  };
}

export async function reach(target: string): Promise<Connection> {
  const shell = target === LOCAL_TARGET ? shellThrough("sh", ["-c"]) : shellThrough("ssh", [target]);
  const probe = await shell.capture(`uname -s; printf '%s\\n' "$HOME"; id -u; hostname -s`);
  if (probe.code !== 0) throw new Error(`Cannot reach ${target} (exit ${probe.code}). Check that \`ssh ${target}\` works with no prompt. See the output above.`);
  const [os = "", home = "", uid = "", name = ""] = probe.stdout.split("\n");
  const layout = hostLayout(parseOS(os), home);
  return { shell, layout, sudo: layout.sudo(Number(uid)), name: name.toLowerCase() };
}

export async function connect(target: string): Promise<Connection> {
  const remote = await reach(target);
  if (remote.sudo && (await remote.shell.capture(`${remote.sudo}-n true`)).code !== 0) {
    throw new Error(`sudo on ${target} asks for a password. autopilot runs sudo over SSH with no terminal. Let this user run sudo without a password, then run the command again.`);
  }
  return remote;
}

export async function must(shell: Shell, step: string, command: string, input?: Buffer): Promise<void> {
  const code = await shell.run(command, input);
  if (code !== 0) throw new Error(`${step} failed on the host (exit ${code}). See the output above.`);
}

export function parseTag(value: string): string {
  if (!RELEASE_TAG.test(value)) throw new Error(`"${value}" is not a release tag such as v1.2.3`);
  return value;
}

export async function latestRelease(): Promise<string> {
  const response = await fetch(`https://api.github.com/repos/${RELEASE_REPO}/releases/latest`, { headers: { accept: "application/vnd.github+json" } });
  if (response.status === 404) throw new Error(`${RELEASE_REPO} has no release (404). Pass --version <tag>.`);
  if (response.status === 403) throw new Error(`GitHub refused the request for the latest release of ${RELEASE_REPO} (403). This is probably the rate limit for your IP address. Try again later, or pass --version <tag>.`);
  if (!response.ok) throw new Error(`GitHub answered ${response.status} for the latest release of ${RELEASE_REPO}. Try again later, or pass --version <tag>.`);
  const release: unknown = await response.json();
  if (typeof release !== "object" || release === null || !("tag_name" in release) || typeof release.tag_name !== "string") {
    throw new Error(`unexpected answer for the latest release of ${RELEASE_REPO}`);
  }
  return parseTag(release.tag_name);
}

// setup.sh and the Node it installs run as root, so they must come from trees that only root can change.
async function assertRootOnly(remote: Connection, dir: string): Promise<void> {
  const { tools } = remote.layout;
  const { code, stdout } = await remote.shell.capture(`find ${dir} $(ls -d ${tools} 2>/dev/null) \\( ! -user root -o \\( ! -type l -perm /022 \\) \\) -print -quit`);
  if (code !== 0 || stdout.trim()) throw new Error(`refusing to run ${dir} as root: ${stdout.trim() || "find failed"} is not owned by root or is writable by others`);
}

export async function installRelease(remote: Connection, release: Release, docker: Host["docker"]): Promise<void> {
  const dir = remote.layout.release(release.kind === "github" ? release.tag : release.commit);
  const { shell, sudo } = remote;
  if ((await shell.run(`test -d ${dir}`)) !== 0) {
    const [step, extract, input] =
      release.kind === "github"
        ? [`download ${release.tag}`, `curl -fsSL https://github.com/${RELEASE_REPO}/archive/refs/tags/${release.tag}.tar.gz | tar -xz --no-same-owner --no-same-permissions --strip-components=1 -C ${dir}.tmp`, undefined]
        : [`upload ${release.commit}`, `tar -x --no-same-owner --no-same-permissions -C ${dir}.tmp`, release.archive()];
    console.log(`==> ${step}`);
    await must(shell, step, `${sudo}sh -c 'set -e; umask 022; rm -rf ${dir}.tmp; mkdir -p ${dir}.tmp; ${extract}; mv ${dir}.tmp ${dir}'`, input);
  }
  // On macOS one user runs the service and the management commands, so no account gains rights from the release.
  if (remote.layout.os === "linux") await assertRootOnly(remote, dir);
  await must(shell, "setup.sh", `${sudo}bash ${dir}/scripts/setup.sh ${dir} ${docker}`);
}

export async function update(path: string, version: string | undefined): Promise<void> {
  const host = loadHost(path);
  const tag = version ? parseTag(version) : await latestRelease();
  await installRelease(await connect(LOCAL_TARGET), { kind: "github", tag }, host.docker);
}

const launchdJob = (): string => `gui/${process.getuid?.()}/${SERVICE}`;

export function restartService(): void {
  const [program, args]: [string, string[]] = LOCAL_LAYOUT.os === "linux" ? ["systemctl", ["restart", SERVICE]] : ["launchctl", ["kickstart", "-k", launchdJob()]];
  const result = spawnSync(program, args, { stdio: "inherit" });
  if (result.status !== 0) throw new Error(`${program} restart of ${SERVICE} failed (exit ${result.status})`);
}

export function startService(): void {
  const [program, args]: [string, string[]] = LOCAL_LAYOUT.os === "linux" ? ["systemctl", ["start", SERVICE]] : serviceState() === "not loaded" ? ["launchctl", ["bootstrap", `gui/${process.getuid?.()}`, join(homedir(), "Library/LaunchAgents", `${SERVICE}.plist`)]] : ["launchctl", ["kickstart", launchdJob()]];
  const result = spawnSync(program, args, { stdio: "inherit" });
  if (result.status !== 0) throw new Error(`${program} could not start ${SERVICE} (exit ${result.status})`);
}

// On Linux the unit stays enabled: a stopped service starts again when the host restarts.
export function stopService(): void {
  const [program, args]: [string, string[]] = LOCAL_LAYOUT.os === "linux" ? ["systemctl", ["stop", SERVICE]] : ["launchctl", ["bootout", launchdJob()]];
  const result = spawnSync(program, args, { stdio: "inherit" });
  if (result.status !== 0) throw new Error(`${program} could not stop ${SERVICE} (exit ${result.status})`);
  console.log(`${SERVICE} stopped. Start it again with autopilot start.`);
}

export function serviceState(): string {
  if (LOCAL_LAYOUT.os === "linux") return spawnSync("systemctl", ["is-active", SERVICE], { encoding: "utf8" }).stdout.trim();
  const job = spawnSync("launchctl", ["print", launchdJob()], { encoding: "utf8" });
  return /^\s*state = (\S+)/m.exec(job.stdout)?.[1] ?? "not loaded";
}

// journalctl reads "-1d" as one day ago; "1d" alone is not a time.
export function journalSince(value: string): string {
  return /^\d+[a-z]+$/i.test(value) ? `-${value}` : value;
}

const SECONDS: Record<string, number> = { s: 1, sec: 1, m: 60, min: 60, h: 3600, d: 86400, w: 604800 };

export function sinceDate(value: string, now: Date): Date {
  const [, amount, unit = ""] = /^(\d+)([a-z]+)$/i.exec(value) ?? [];
  const seconds = SECONDS[unit.toLowerCase()];
  if (amount && seconds) return new Date(now.getTime() - Number(amount) * seconds * 1000);
  const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (value === "today") return midnight;
  if (value === "yesterday") return new Date(midnight.getFullYear(), midnight.getMonth(), midnight.getDate() - 1);
  // Like journalctl, a date alone is local midnight; Date.parse would read it as UTC.
  const time = Date.parse(/^\d{4}-\d\d-\d\d$/.test(value) ? `${value}T00:00` : value);
  if (Number.isNaN(time)) throw new Error(`--since "${value}" is not a time such as 1d, 90min, 2026-11-15 or yesterday`);
  return new Date(time);
}

const STAMP = /^(?:\{"at":")?(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z)/;

// A line without a time, such as a stack trace, belongs to the line above it.
export function linesSince(text: string, since: Date): string[] {
  let keep = false;
  return text.split("\n").filter((line) => {
    const stamp = STAMP.exec(line)?.[1];
    if (stamp) keep = Date.parse(stamp) >= since.getTime();
    return keep && line !== "";
  });
}

function journal(args: string[]): void {
  const result = spawnSync("journalctl", [...args, "--no-pager"], { stdio: "inherit" });
  if (result.status !== 0) throw new Error(`journalctl failed (exit ${result.status})`);
}

function logFile(path: string, since: string | undefined, lines: number): void {
  const text = existsSync(path) ? readFileSync(path, "utf8") : "";
  const shown = since ? linesSince(text, sinceDate(since, new Date())) : text.split("\n").filter(Boolean).slice(-lines);
  for (const line of shown) console.log(line);
}

export function showStatus(path: string): void {
  const host = loadHost(path);
  console.log(`host:    ${host.name}`);
  console.log(`service: ${serviceState()}`);
  console.log(`release: ${readlinkSync(LOCAL_LAYOUT.current)}`);
  console.log(`watch:   ${host.allow.join(", ") || "(nothing)"}`);
  const { logs } = LOCAL_LAYOUT;
  if (logs.kind === "journal") journal(["--identifier", SERVICE, "--lines", "20", "--output", "cat"]);
  else logFile(logs.service, undefined, 20);
}

export function showLogs(since: string | undefined): void {
  const { logs } = LOCAL_LAYOUT;
  if (logs.kind === "files") return logFile(logs.service, since, 100);
  journal(["--identifier", SERVICE, "--output", "short-iso", ...(since ? ["--since", journalSince(since)] : ["--lines", "100"])]);
}

export function showAudit(since: string | undefined): void {
  const { logs } = LOCAL_LAYOUT;
  if (logs.kind === "files") return logFile(logs.audit, since ?? "1d", 0);
  journal(["--identifier", AUDIT_TAG, "--output", "cat", "--since", journalSince(since ?? "1d")]);
}
