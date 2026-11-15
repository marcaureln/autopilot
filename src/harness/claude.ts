import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import managedSettings from "../../harness/claude/managed-settings.json" with { type: "json" };
import type { Agent } from "../core/config.ts";
import type { Host } from "../core/host.ts";

const run = promisify(execFile);

const IMAGE_DIR = new URL("../../harness/claude/", import.meta.url).pathname;
const IMAGE_FILES = ["Dockerfile", "managed-settings.json"];

const SETTINGS = JSON.stringify({ attribution: managedSettings.attribution });

// Entries of the personal config that Claude Code reads. Each one is mounted on its own, so the rest
// of ~/.claude (sessions, caches) stays writable inside the container.
const PERSONAL_ENTRIES = ["CLAUDE.md", "settings.json", "agents", "commands"];

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
};

export function claudeTokenFile(): string {
  if (process.env.CREDENTIALS_DIRECTORY) return join(process.env.CREDENTIALS_DIRECTORY, "claude-token");
  if (process.env.AUTOPILOT_CLAUDE_TOKEN_FILE) return process.env.AUTOPILOT_CLAUDE_TOKEN_FILE;
  throw new Error("no Claude token: run under the autopilot service, or set AUTOPILOT_CLAUDE_TOKEN_FILE");
}

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

function tail(text: string): string {
  return text.slice(-2000).trim();
}

export async function runClaude(job: HarnessRun): Promise<void> {
  const tag = imageTag();
  await ensureImage(tag);
  await run("docker", ["rm", "--force", job.name]).catch(() => undefined);

  const configDir = job.claudeConfigDir;
  const personal = configDir
    ? PERSONAL_ENTRIES.filter((entry) => existsSync(join(configDir, entry))).flatMap((entry) => ["--volume", `${join(configDir, entry)}:/root/.claude/${entry}:ro`])
    : [];
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
    // Only the variable name: docker reads the value from its own environment, so it stays out of the process list.
    "--env",
    "CLAUDE_CODE_OAUTH_TOKEN",
    // Claude Code refuses to bypass permissions as root unless it is told it runs in a sandbox.
    // Root is needed: with rootless Docker it is the host user that owns /work.
    "--env",
    "IS_SANDBOX=1",
    "--volume",
    `${job.workdir}:/work`,
    "--volume",
    `${job.skillsDir}:/root/.claude/skills:ro`,
    ...personal,
    tag,
    "claude",
    "--print",
    "--model",
    job.model,
    ...(job.effort ? ["--effort", job.effort] : []),
    "--permission-mode",
    "bypassPermissions",
    "--settings",
    SETTINGS,
  ];

  const token = readFileSync(claudeTokenFile(), "utf8").trim();
  if (!token) throw new Error(`the Claude token file ${claudeTokenFile()} is empty`);
  const child = spawn("docker", args, {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, CLAUDE_CODE_OAUTH_TOKEN: token },
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

  if (timedOut) throw new Error(`the agent timed out after ${job.timeoutMinutes} minutes`);
  if (code !== 0) throw new Error(`the agent exited with code ${code}`, { cause: output });
}
