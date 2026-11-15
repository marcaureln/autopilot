import { spawn, spawnSync } from "node:child_process";
import { readlinkSync } from "node:fs";
import { AUDIT_TAG } from "../core/audit.ts";
import { loadHost, type Host } from "../core/host.ts";

const RELEASE_REPO = "marcaureln/autopilot";
const TAG = /^v\d+\.\d+\.\d+$/;
const TOOLS = "/opt/autopilot-tools";

export type Release = { kind: "github"; tag: string } | { kind: "checkout"; commit: string; archive: () => Buffer };

export type Shell = {
  sudo: string;
  run(command: string, input?: Buffer): Promise<number>;
  capture(command: string): Promise<{ code: number; stdout: string }>;
};

function shellThrough(program: string, args: string[], sudo: string): Shell {
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
    sudo,
    run: async (command, input) => (await exec(command, input, false)).code,
    capture: (command) => exec(command, undefined, true),
  };
}

// Without a second sudo, setup.sh still sees the SUDO_USER that ran `sudo autopilot update`.
export const localShell = (): Shell => shellThrough("sh", ["-c"], process.getuid?.() === 0 ? "" : "sudo ");
export const sshShell = (target: string): Shell => shellThrough("ssh", [target], "sudo ");

export async function must(shell: Shell, step: string, command: string, input?: Buffer): Promise<void> {
  const code = await shell.run(command, input);
  if (code !== 0) throw new Error(`${step} failed on the host (exit ${code})`);
}

export function parseTag(value: string): string {
  if (!TAG.test(value)) throw new Error(`"${value}" is not a release tag such as v1.2.3`);
  return value;
}

export async function latestRelease(): Promise<string> {
  const response = await fetch(`https://api.github.com/repos/${RELEASE_REPO}/releases/latest`, { headers: { accept: "application/vnd.github+json" } });
  if (!response.ok) throw new Error(`no release of ${RELEASE_REPO} found (${response.status})`);
  const release: unknown = await response.json();
  if (typeof release !== "object" || release === null || !("tag_name" in release) || typeof release.tag_name !== "string") {
    throw new Error(`unexpected answer for the latest release of ${RELEASE_REPO}`);
  }
  return parseTag(release.tag_name);
}

// setup.sh and the Node it installs run as root, so they must come from trees that only root can change.
async function assertRootOnly(shell: Shell, dir: string): Promise<void> {
  const { code, stdout } = await shell.capture(`find ${dir} $(ls -d ${TOOLS} 2>/dev/null) \\( ! -user root -o \\( ! -type l -perm /022 \\) \\) -print -quit`);
  if (code !== 0 || stdout.trim()) throw new Error(`refusing to run ${dir} as root: ${stdout.trim() || "find failed"} is not owned by root or is writable by others`);
}

export async function installRelease(shell: Shell, release: Release, docker: Host["docker"]): Promise<void> {
  const dir = `/opt/autopilot-${release.kind === "github" ? release.tag : release.commit}`;
  if ((await shell.run(`test -d ${dir}`)) !== 0) {
    const [step, extract, input] =
      release.kind === "github"
        ? [`download ${release.tag}`, `curl -fsSL https://github.com/${RELEASE_REPO}/archive/refs/tags/${release.tag}.tar.gz | tar -xz --no-same-owner --no-same-permissions --strip-components=1 -C ${dir}.tmp`, undefined]
        : [`upload ${release.commit}`, `tar -x --no-same-owner --no-same-permissions -C ${dir}.tmp`, release.archive()];
    console.log(`==> ${step}`);
    await must(shell, step, `${shell.sudo}sh -c 'set -e; umask 022; rm -rf ${dir}.tmp; mkdir -p ${dir}.tmp; ${extract}; mv ${dir}.tmp ${dir}'`, input);
  }
  await assertRootOnly(shell, dir);
  await must(shell, "setup.sh", `${shell.sudo}bash ${dir}/host/setup.sh ${dir} ${docker}`);
}

export async function update(path: string, version: string | undefined): Promise<void> {
  const host = loadHost(path);
  const tag = version ? parseTag(version) : await latestRelease();
  await installRelease(localShell(), { kind: "github", tag }, host.docker);
}

// journalctl reads "-1d" as one day ago; "1d" alone is not a time.
export function journalSince(value: string): string {
  return /^\d+[a-z]+$/i.test(value) ? `-${value}` : value;
}

function journal(args: string[]): void {
  const result = spawnSync("journalctl", [...args, "--no-pager"], { stdio: "inherit" });
  if (result.status !== 0) throw new Error(`journalctl failed (exit ${result.status})`);
}

export function showStatus(path: string): void {
  const host = loadHost(path);
  console.log(`host:    ${host.name}`);
  console.log(`service: ${spawnSync("systemctl", ["is-active", "autopilot"], { encoding: "utf8" }).stdout.trim()}`);
  console.log(`release: ${readlinkSync("/opt/autopilot")}`);
  console.log(`allow:   ${host.allow.join(", ") || "(empty)"}`);
  journal(["--identifier", "autopilot", "--lines", "20", "--output", "cat"]);
}

export function showLogs(since: string | undefined): void {
  journal(["--identifier", "autopilot", "--output", "short-iso", ...(since ? ["--since", journalSince(since)] : ["--lines", "100"])]);
}

export function showAudit(since: string | undefined): void {
  journal(["--identifier", AUDIT_TAG, "--output", "cat", "--since", journalSince(since ?? "1d")]);
}
