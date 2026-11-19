import { createHash } from "node:crypto";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { Audit } from "../core/audit.ts";
import type { Agent } from "../core/config.ts";
import type { Devcontainer } from "../core/devcontainer-cli.ts";
import { ensureImage, runContainer, type Mount } from "../core/docker.ts";
import { PROMPT_FILE, RUN_DIR, shellEnvFile, type AgentFeature } from "../core/environment.ts";
import type { Host } from "../core/host.ts";
import { claude } from "./claude.ts";
import { opencode } from "./opencode.ts";
import type { Credentials, Harness } from "./types.ts";

export const HARNESSES: Record<Agent["harness"], Harness> = { claude, opencode };

export async function agentImage(harness: Harness): Promise<string> {
  const hash = createHash("sha256");
  for (const file of harness.imageFiles) hash.update(readFileSync(join(harness.dir, file)));
  const tag = `autopilot-${basename(harness.dir)}:${hash.digest("hex").slice(0, 12)}`;
  await ensureImage(tag, harness.dir);
  return tag;
}

function tail(text: string): string {
  return text.slice(-2000).trim();
}

export type ImageRun = {
  harness: Harness;
  credentials: Credentials;
  name: string;
  model: string;
  effort?: Agent["effort"];
  promptFile: string;
  skillsDir: string;
  workdir: string;
  configDir?: string;
  jobDir: string;
  limits: Host["limits"];
  timeoutMinutes: number;
  audit: Audit;
};

// Root is needed: with rootless Docker it is the host user that owns /work.
export async function runAgent(job: ImageRun): Promise<void> {
  const { harness } = job;
  const result = await runContainer({
    name: job.name,
    image: await agentImage(harness),
    command: harness.command(job.model, job.effort),
    mounts: [
      { source: job.workdir, target: "/work", readonly: false },
      { source: job.promptFile, target: PROMPT_FILE, readonly: true },
      ...harness.mounts(job.skillsDir, job.configDir, job.jobDir),
    ],
    network: "bridge",
    env: harness.env("/work"),
    passthroughEnv: harness.secretEnv(job.credentials),
    ...(harness.prompt === "stdin" && { input: readFileSync(job.promptFile) }),
    limits: job.limits,
    timeoutMs: job.timeoutMinutes * 60 * 1000,
    audit: job.audit,
  });
  if (result.timedOut) throw new Error(`the agent timed out after ${job.timeoutMinutes} minutes`);
  if (result.exit !== 0) throw new Error(`the agent exited with code ${result.exit}`, { cause: tail(result.output) });
}

export function devcontainerSetup(harness: Harness, jobDir: string, runDir: string, skillsDir: string, configDir: string | undefined): { mounts: Mount[]; feature: AgentFeature } {
  return {
    mounts: [{ source: runDir, target: RUN_DIR, readonly: true }, harness.managedConfig, ...harness.mounts(skillsDir, configDir, jobDir)],
    feature: { id: harness.featureId, source: join(harness.dir, "feature"), version: harness.version() },
  };
}

export type DevcontainerRun = {
  harness: Harness;
  credentials: Credentials;
  devcontainer: Devcontainer;
  containerId: string;
  runDir: string;
  prompt: string;
  workdir: string;
  model: string;
  effort?: Agent["effort"];
  timeoutMs: number;
};

const ENV_NAME = "agent-env.sh";

// The env file is sourced after the unset, so the host's values are the ones the agent sees.
export function devcontainerScript(harness: Harness): string {
  const unset = harness.hostEnvPrefixes.length > 0 ? `for name in $(env | cut -d= -f1); do case "$name" in ${harness.hostEnvPrefixes.map((prefix) => `${prefix}*`).join("|")}) unset "$name" ;; esac; done && ` : "";
  const stdin = harness.prompt === "stdin" ? ` < ${PROMPT_FILE}` : "";
  return `cd "$1" && shift && ${unset}set -a && . ${RUN_DIR}/${ENV_NAME} && set +a && exec "$@"${stdin}`;
}

// The host writes the prompt and the secrets after up, so the repo's install never sees them.
// safe.directory: the checkout belongs to the host user.
export async function runAgentInDevcontainer(job: DevcontainerRun): Promise<void> {
  const { harness } = job;
  writeFileSync(join(job.runDir, basename(PROMPT_FILE)), job.prompt);
  writeFileSync(join(job.runDir, ENV_NAME), shellEnvFile({ ...harness.env(job.workdir), ...harness.secretEnv(job.credentials) }), { mode: 0o600, flag: "wx" });
  const result = await job.devcontainer.exec(job.containerId, ["sh", "-c", devcontainerScript(harness), "sh", job.workdir, ...harness.command(job.model, job.effort)], {
    env: { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "safe.directory", GIT_CONFIG_VALUE_0: "*" },
    timeoutMs: job.timeoutMs,
  });
  if (result.timedOut) throw new Error(`the agent timed out after ${Math.round(job.timeoutMs / 60_000)} minutes`, { cause: tail(result.output) });
  if (result.exit !== 0) throw new Error(`the agent exited with code ${result.exit}`, { cause: tail(result.output) });
  rmSync(join(job.runDir, ENV_NAME));
}
