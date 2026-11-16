import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import managedSettings from "../../docker/claude/managed-settings.json" with { type: "json" };
import type { Audit } from "../core/audit.ts";
import type { Agent } from "../core/config.ts";
import type { Devcontainer } from "../core/devcontainer-cli.ts";
import type { Mount } from "../core/docker.ts";
import { RUN_DIR } from "../core/environment.ts";
import type { Host } from "../core/host.ts";

const run = promisify(execFile);

const IMAGE_DIR = new URL("../../docker/claude/", import.meta.url).pathname;
const IMAGE_FILES = ["Dockerfile", "managed-settings.json"];

const SETTINGS = JSON.stringify({ attribution: managedSettings.attribution });

// Entries of the personal config that Claude Code reads. Each one is mounted on its own, so the rest
// of ~/.claude (sessions, caches) stays writable inside the container.
const PERSONAL_ENTRIES = ["CLAUDE.md", "settings.json", "agents", "commands"];

// In the dev container, the host writes these into RUN_DIR after up, so the repo's install never sees the token.
export const TOKEN_NAME = "claude-token";
export const PROMPT_NAME = "prompt.md";

// The agent image has them built in. A dev container gets them as a read-only mount.
export const MANAGED_SETTINGS: Mount = { source: join(IMAGE_DIR, "managed-settings.json"), target: "/etc/claude-code/managed-settings.json", readonly: true };

export type HarnessRun = {
  name: string;
  model: string;
  effort?: Agent["effort"];
  promptFile: string;
  skillsDir: string;
  workdir: string;
  claudeConfigDir?: string;
  limits: Host["limits"];
  timeoutMinutes: number;
  claudeToken: string;
  audit: Audit;
};

function imageTag(): string {
  const hash = createHash("sha256");
  for (const file of IMAGE_FILES) hash.update(readFileSync(join(IMAGE_DIR, file)));
  return `autopilot-claude:${hash.digest("hex").slice(0, 12)}`;
}

async function ensureImage(tag: string): Promise<void> {
  const exists = await run("docker", ["image", "inspect", tag]).then(
    () => true,
    () => false,
  );
  if (!exists) await run("docker", ["build", "--quiet", "--tag", tag, IMAGE_DIR], { maxBuffer: 16 * 1024 * 1024 });
}

// The Claude Code version of the agent image, which the dev containers that init writes pin too.
export function claudeCodeVersion(): string {
  const match = /@anthropic-ai\/claude-code@(\d+\.\d+\.\d+)/.exec(readFileSync(join(IMAGE_DIR, "Dockerfile"), "utf8"));
  if (!match?.[1]) throw new Error("docker/claude/Dockerfile pins no Claude Code version");
  return match[1];
}

export async function claudeImage(): Promise<string> {
  const tag = imageTag();
  await ensureImage(tag);
  return tag;
}

// The agent runs as root in both the agent image and the dev container.
export function claudeMounts(skillsDir: string, claudeConfigDir: string | undefined): Mount[] {
  const personal = claudeConfigDir
    ? PERSONAL_ENTRIES.filter((entry) => existsSync(join(claudeConfigDir, entry))).map((entry) => ({ source: join(claudeConfigDir, entry), target: `/root/.claude/${entry}`, readonly: true }))
    : [];
  return [{ source: skillsDir, target: "/root/.claude/skills", readonly: true }, ...personal];
}

function claudeArgs(model: string, effort: Agent["effort"]): string[] {
  return ["claude", "--print", "--model", model, ...(effort ? ["--effort", effort] : []), "--permission-mode", "bypassPermissions", "--settings", SETTINGS];
}

function tail(text: string): string {
  return text.slice(-2000).trim();
}

export async function runClaude(job: HarnessRun): Promise<void> {
  const tag = await claudeImage();
  await run("docker", ["rm", "--force", job.name]).catch(() => undefined);

  const mounts = [{ source: job.workdir, target: "/work", readonly: false }, ...claudeMounts(job.skillsDir, job.claudeConfigDir)];
  // CLAUDE_CODE_OAUTH_TOKEN is only a name: docker reads the value from its own environment, so it
  // stays out of the process list. IS_SANDBOX: Claude Code refuses to bypass permissions as root
  // unless it is told it runs in a sandbox. Root is needed: with rootless Docker it is the host user
  // that owns /work.
  const env: Record<string, string | undefined> = { CLAUDE_CODE_OAUTH_TOKEN: undefined, IS_SANDBOX: "1" };
  const args = [
    "run",
    "--rm",
    "--interactive",
    "--name",
    job.name,
    "--memory",
    job.limits.memory,
    "--memory-swap",
    job.limits.memory,
    "--cpus",
    String(job.limits.cpus),
    "--pids-limit",
    String(job.limits.pids),
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    ...Object.entries(env).flatMap(([name, value]) => ["--env", value === undefined ? name : `${name}=${value}`]),
    ...mounts.flatMap(({ source, target, readonly }) => ["--volume", `${source}:${target}${readonly ? ":ro" : ""}`]),
    tag,
    ...claudeArgs(job.model, job.effort),
  ];

  job.audit({
    event: "container.started",
    name: job.name,
    image: tag,
    mounts: mounts.map((mount) => mount.target),
    env: Object.keys(env),
    caps: { memory: job.limits.memory, cpus: job.limits.cpus, pids: job.limits.pids, timeout_minutes: job.timeoutMinutes, cap_drop: "ALL" },
  });
  const started = Date.now();
  const child = spawn("docker", args, {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, CLAUDE_CODE_OAUTH_TOKEN: job.claudeToken },
  });
  child.stdin.end(readFileSync(job.promptFile));
  let output = "";
  child.stdout.on("data", (chunk: Buffer) => (output = tail(output + chunk.toString())));
  child.stderr.on("data", (chunk: Buffer) => (output = tail(output + chunk.toString())));

  let timedOut = false;
  const timer = setTimeout(
    () => {
      timedOut = true;
      void run("docker", ["kill", job.name]).catch(() => undefined);
    },
    job.timeoutMinutes * 60 * 1000,
  );
  const code = await new Promise<number>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (exitCode) => resolve(exitCode ?? 1));
  }).finally(() => clearTimeout(timer));
  job.audit({ event: "container.ended", name: job.name, exit: code, timed_out: timedOut, duration_seconds: Math.round((Date.now() - started) / 1000) });

  if (timedOut) throw new Error(`the agent timed out after ${job.timeoutMinutes} minutes`);
  if (code !== 0) throw new Error(`the agent exited with code ${code}`, { cause: output });
}

export type DevcontainerRun = {
  devcontainer: Devcontainer;
  containerId: string;
  workdir: string;
  model: string;
  effort?: Agent["effort"];
  timeoutMs: number;
};

// The token reaches Claude Code through a file, never through an argument (the process list shows
// arguments). IS_SANDBOX and safe.directory: see runClaude and the checks; the checkout belongs to the host user.
export async function runClaudeInDevcontainer(job: DevcontainerRun): Promise<void> {
  const script = `cd "$1" && shift && CLAUDE_CODE_OAUTH_TOKEN=$(cat ${RUN_DIR}/${TOKEN_NAME}) && export CLAUDE_CODE_OAUTH_TOKEN && exec "$@" < ${RUN_DIR}/${PROMPT_NAME}`;
  const result = await job.devcontainer.exec(job.containerId, ["sh", "-c", script, "sh", job.workdir, ...claudeArgs(job.model, job.effort)], {
    env: { IS_SANDBOX: "1", GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "safe.directory", GIT_CONFIG_VALUE_0: "*" },
    timeoutMs: job.timeoutMs,
  });
  if (result.timedOut) throw new Error(`the agent timed out after ${Math.round(job.timeoutMs / 60_000)} minutes`, { cause: tail(result.output) });
  if (result.exit !== 0) throw new Error(`the agent exited with code ${result.exit}`, { cause: tail(result.output) });
}
