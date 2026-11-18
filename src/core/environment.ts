import { createHash } from "node:crypto";
import { cpSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { Audit } from "./audit.ts";
import { composeProblems, devcontainerProblems, dockerfileProblems, type Resolve } from "./devcontainer.ts";
import type { Devcontainer, Features } from "./devcontainer-cli.ts";
import type { ContainerResult, Mount } from "./docker.ts";
import type { Host } from "./host.ts";
import { readAgentFile, writeRepoFile } from "./workspace.ts";

// The environment of a job is the repo's own .devcontainer/. The host checks it with the guardrails,
// then starts it through an override that adds the host caps and mounts.

// Written next to the repo's devcontainer.json, so its relative paths resolve the same way.
export const OVERRIDE_FILE = "autopilot.devcontainer.json";
export const COMPOSE_OVERRIDE_FILE = "autopilot.compose.json";
// An internal network: the dev container keeps its services on it after the host cuts its other networks.
const SERVICES_NETWORK = "autopilot-services";

// Mounted read-only at this path. The host writes files into it after up, so the lifecycle
// commands of the repo never see them.
export const RUN_DIR = "/autopilot";
export const SECRETS_NAME = "secrets.sh";
export const SECRETS_FILE = `${RUN_DIR}/${SECRETS_NAME}`;
export const PROMPT_FILE = `${RUN_DIR}/prompt.md`;

// Our own feature, to pin the agent version. The Dev Container CLI finds a local feature only next to
// devcontainer.json, so startEnvironment copies it there as ./<id>.
export type AgentFeature = { id: string; source: string; version: string };

export class EnvironmentRefused extends Error {
  readonly problems: string[];
  constructor(problems: string[]) {
    super(`autopilot does not start the repo's dev container:\n${problems.map((problem) => `- ${problem}`).join("\n")}`);
    this.problems = problems;
  }
}

type Overrides = { devcontainer: Record<string, unknown>; compose?: Record<string, unknown> };

function mountString({ source, target, readonly }: Mount): string {
  return `type=bind,source=${source},target=${target}${readonly ? ",readonly" : ""}`;
}

// The guardrails refuse runArgs and mounts in the repo's config, so the host values are the only ones.
// Root: with rootless Docker the host user that owns the checkout is root in the container, and
// another user cannot write to it.
export function overrideFiles(
  configuration: Record<string, unknown>,
  { limits, mounts, composeServices }: { limits: Host["limits"]; mounts: Mount[]; composeServices: Record<string, Record<string, unknown>> | undefined },
): Overrides {
  const { configFilePath: _, ...config } = configuration;
  const base = { ...config, remoteUser: "root" };
  const composeFile = config.dockerComposeFile;
  if (composeFile === undefined) {
    const runArgs = [`--memory=${limits.memory}`, `--memory-swap=${limits.memory}`, `--cpus=${limits.cpus}`, `--pids-limit=${limits.pids}`, "--security-opt=no-new-privileges"];
    // The CLI mounts the repo at /workspaces/<folder> and ignores `workspaceFolder` without `workspaceMount`,
    // which the guardrails refuse. So the host mounts the repo where the repo expects it. The guardrails
    // allow only a plain absolute path, so the value cannot add mount options.
    const workspaceMount = typeof config.workspaceFolder === "string" ? { workspaceMount: `type=bind,source=\${localWorkspaceFolder},target=${config.workspaceFolder}` } : {};
    return { devcontainer: { ...base, ...workspaceMount, runArgs, mounts: mounts.map(mountString) } };
  }
  // runArgs do not apply to compose, and the CLI drops `readonly` from the mounts of a compose
  // container, so both go in a compose file of the host.
  const caps = { mem_limit: limits.memory, memswap_limit: limits.memory, cpus: limits.cpus, pids_limit: limits.pids, security_opt: ["no-new-privileges:true"] };
  const services = Object.fromEntries(
    Object.entries(composeServices ?? {}).map(([name, service]) => [
      name,
      {
        ...caps,
        ...(service.network_mode === undefined && { networks: ["default", SERVICES_NETWORK] }),
        ...(name === config.service && { volumes: mounts.map(({ source, target, readonly }) => ({ type: "bind", source, target, read_only: readonly })) }),
      },
    ]),
  );
  return {
    devcontainer: { ...base, dockerComposeFile: [...[composeFile].flat(), COMPOSE_OVERRIDE_FILE] },
    compose: { services, networks: { [SERVICES_NETWORK]: { internal: true } } },
  };
}

// Sourced by the check commands. The values are single-quoted, so the shell reads them as they are.
export function shellEnvFile(secrets: Record<string, string>): string {
  return Object.entries(secrets)
    .map(([name, value]) => `export ${name}='${value.replaceAll("'", "'\\''")}'\n`)
    .join("");
}

// devcontainer exec starts in the home folder of the user, not in the workspace folder.
export function checkCommand(command: string, workdir: string, withSecrets: boolean): string[] {
  const secrets = withSecrets ? `set -a && . ${SECRETS_FILE} && set +a && ` : "";
  return ["sh", "-c", `cd "$1" && ${secrets}exec sh -c "$2"`, "sh", workdir, command];
}

export type UpResult = { kind: "up"; containerId: string; workspaceFolder: string } | { kind: "failed"; message: string };

export function parseUpResult(stdout: string): UpResult {
  const line = stdout.trim().split("\n").at(-1) ?? "";
  if (!line.startsWith("{")) return { kind: "failed", message: "the Dev Container CLI wrote no result" };
  const result: Record<string, unknown> = JSON.parse(line);
  if (result.outcome === "success" && typeof result.containerId === "string" && typeof result.remoteWorkspaceFolder === "string") {
    return { kind: "up", containerId: result.containerId, workspaceFolder: result.remoteWorkspaceFolder };
  }
  return { kind: "failed", message: [result.description, result.message].filter((part) => typeof part === "string" && part.length > 0).join(": ") || "devcontainer up failed" };
}

// ---- Start: read, check, override, up ----

function inside(path: string, root: string): string | undefined {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel)) ? rel : undefined;
}

const resolvePath: Resolve = (path) => {
  try {
    return realpathSync(path);
  } catch {
    return undefined;
  }
};

function readDockerfile(workspace: string, path: string, problems: string[]): void {
  const rel = inside(path, workspace);
  if (rel === undefined) return void problems.push(`the Dockerfile ${path} is outside the repo`);
  const text = readAgentFile(workspace, rel, 1024 * 1024);
  if (text === undefined) return void problems.push(`the Dockerfile ${rel} does not exist`);
  problems.push(...dockerfileProblems(text));
}

export type EnvironmentOptions = {
  devcontainer: Devcontainer;
  // The host's own copy of the checkout: the override files are written into it.
  workspace: string;
  idLabel: string;
  limits: Host["limits"];
  mounts: Mount[];
  // The agent to install in the dev container, or undefined for none (the checks).
  agentFeature: AgentFeature | undefined;
  timeoutMs: number;
  audit: Audit;
};

export type Started = { kind: "up"; containerId: string; workspaceFolder: string } | { kind: "failed"; result: ContainerResult };

export async function startEnvironment(options: EnvironmentOptions): Promise<Started> {
  const { devcontainer, idLabel, limits, mounts, agentFeature, audit } = options;
  const workspace = realpathSync(options.workspace);
  const read = await devcontainer.readConfiguration(workspace, {});
  const configDir = dirname(realpathSync(read.configFile));
  const configRel = inside(configDir, workspace);
  // The host names the compose project, so its volumes and networks never match those of another project.
  const projectName = `autopilot-${createHash("sha256").update(idLabel).digest("hex").slice(0, 12)}`;
  if (configRel === undefined) throw new EnvironmentRefused([`devcontainer.json is outside the repo (${read.configFile})`]);

  const problems = devcontainerProblems(read.merged);
  let composeServices: Record<string, Record<string, unknown>> | undefined;
  const composeFile = read.configuration.dockerComposeFile;
  if (composeFile !== undefined) {
    const files = [composeFile].flat().map((file) => join(configDir, String(file)));
    const outside = files.filter((file) => inside(file, workspace) === undefined);
    if (outside.length > 0) throw new EnvironmentRefused(outside.map((file) => `the compose file ${file} is outside the repo`));
    const compose = await devcontainer.composeConfig(files, projectName);
    problems.push(...composeProblems(compose, workspace, resolvePath));
    composeServices = compose.services ?? {};
    const service = read.configuration.service;
    // The host cuts the network of the dev container for the checks, and it cannot cut a shared one.
    if (typeof service === "string" && composeServices[service]?.network_mode !== undefined) problems.push(`compose service ${service}: the dev container cannot have \`network_mode\``);
    for (const [name, service] of Object.entries(composeServices)) {
      const build = service.build;
      if (typeof build !== "object" || build === null) continue;
      if ("dockerfile_inline" in build && typeof build.dockerfile_inline === "string") problems.push(...dockerfileProblems(build.dockerfile_inline));
      else if ("context" in build && typeof build.context === "string") {
        // composeProblems already refuses a context outside the repo.
        if (inside(resolvePath(build.context) ?? "/", workspace) === undefined) continue;
        const dockerfile = "dockerfile" in build && typeof build.dockerfile === "string" ? build.dockerfile : "Dockerfile";
        readDockerfile(workspace, isAbsolute(dockerfile) ? dockerfile : join(build.context, dockerfile), problems);
      } else problems.push(`compose service ${name}: autopilot cannot read its build`);
    }
  }
  const build = read.configuration.build;
  const context = typeof build === "object" && build !== null && "context" in build && typeof build.context === "string" ? resolve(configDir, build.context) : undefined;
  if (context !== undefined && inside(resolvePath(context) ?? "/", workspace) === undefined) problems.push(`devcontainer.json: the build context ${context} is outside the repo`);
  const dockerfile = typeof build === "object" && build !== null && "dockerfile" in build ? build.dockerfile : read.configuration.dockerFile;
  if (typeof dockerfile === "string") readDockerfile(workspace, resolve(configDir, dockerfile), problems);
  if (problems.length > 0) throw new EnvironmentRefused(problems);

  const features: Features = agentFeature === undefined ? {} : { [`./${agentFeature.id}`]: { version: agentFeature.version } };
  if (agentFeature !== undefined) cpSync(agentFeature.source, join(configDir, agentFeature.id), { recursive: true });
  const overrides = overrideFiles(read.configuration, { limits, mounts, composeServices });
  const overridePath = join(configRel, OVERRIDE_FILE);
  writeRepoFile(workspace, overridePath, `${JSON.stringify(overrides.devcontainer, null, 2)}\n`);
  if (overrides.compose) writeRepoFile(workspace, join(configRel, COMPOSE_OVERRIDE_FILE), `${JSON.stringify(overrides.compose, null, 2)}\n`);

  audit({
    event: "container.started",
    name: idLabel,
    image: ["devcontainer", ...Object.keys(features)].join(" + "),
    mounts: mounts.map((mount) => `${mount.target}${mount.readonly ? ":ro" : ""}`),
    env: [],
    caps: { memory: limits.memory, cpus: limits.cpus, pids: limits.pids, security_opt: "no-new-privileges" },
  });
  const up = await devcontainer.up({ workspace, overrideConfig: join(workspace, overridePath), idLabel, projectName, additionalFeatures: features, timeoutMs: options.timeoutMs });
  const parsed = up.timedOut ? undefined : parseUpResult(up.stdout);
  if (parsed?.kind === "up") return parsed;
  const message = parsed?.message ?? "timed out";
  return { kind: "failed", result: { ...up, exit: up.exit === 0 ? 1 : up.exit, output: `${message}\n\n${up.output}`.trim() } };
}

export async function stopEnvironment(devcontainer: Devcontainer, idLabel: string, audit: Audit): Promise<void> {
  await devcontainer.down(idLabel);
  audit({ event: "container.removed", name: idLabel });
}
