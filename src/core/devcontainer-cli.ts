import { execFile, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { ComposeConfig } from "./devcontainer.ts";
import { clientEnv, type ContainerResult } from "./docker.ts";

const run = promisify(execFile);

// The CLI is a dependency of autopilot. It runs with the node that runs autopilot, so the service
// needs no node in its PATH.
const CLI = fileURLToPath(import.meta.resolve("@devcontainers/cli/devcontainer.js"));

const OUTPUT_TAIL = 16_000;
const MAX_BUFFER = 64 * 1024 * 1024;

export type Configuration = {
  // devcontainer.json as the repo wrote it, comments removed.
  configuration: Record<string, unknown>;
  // With what the features add, such as mounts or privileges.
  merged: Record<string, unknown>;
  configFile: string;
};

export type Features = Record<string, Record<string, unknown>>;

export type UpOptions = { workspace: string; overrideConfig: string; idLabel: string; projectName: string; additionalFeatures: Features; timeoutMs: number };

export type Devcontainer = {
  readConfiguration(workspace: string, additionalFeatures: Features): Promise<Configuration>;
  composeConfig(files: string[], projectName: string): Promise<ComposeConfig>;
  // Builds, starts and runs the lifecycle commands (the install). `stdout` holds the result line.
  up(options: UpOptions): Promise<ContainerResult & { stdout: string }>;
  exec(containerId: string, command: string[], options: { env?: Record<string, string>; timeoutMs: number }): Promise<ContainerResult>;
  // Disconnects the container and the other containers of its compose project from every network
  // that reaches outside Docker, stopped ones too. Otherwise a service could carry the secrets out for the container.
  cutNetwork(containerId: string): Promise<void>;
  // The CLI has no down command: autopilot removes what carries the id label, and its compose project.
  down(idLabel: string): Promise<void>;
};

function spawnTail(command: string, args: string[], timeoutMs: number, env: Record<string, string> = {}): Promise<ContainerResult & { stdout: string }> {
  const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], env: { ...clientEnv(process.env), ...env } });
  let output = "";
  let stdout = "";
  let truncated = false;
  const append = (chunk: Buffer) => {
    output += chunk.toString();
    if (output.length > OUTPUT_TAIL) {
      output = output.slice(-OUTPUT_TAIL);
      truncated = true;
    }
  };
  child.stdout.on("data", (chunk: Buffer) => {
    stdout = (stdout + chunk.toString()).slice(-OUTPUT_TAIL);
    append(chunk);
  });
  child.stderr.on("data", append);
  let timedOut = false;
  // Killing the CLI leaves the command running in the container: down() removes the container.
  const timer = setTimeout(
    () => {
      timedOut = true;
      child.kill("SIGKILL");
    },
    Math.max(timeoutMs, 1000),
  );
  return new Promise<number>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => resolve(code ?? 1));
  })
    .finally(() => clearTimeout(timer))
    .then((exit) => ({ exit, timedOut, output: output.trim(), truncated, stdout }));
}

async function docker(args: string[]): Promise<string> {
  const { stdout } = await run("docker", args, { env: clientEnv(process.env), maxBuffer: MAX_BUFFER });
  return stdout.trim();
}

function lastJsonLine(stdout: string): Record<string, unknown> {
  const line = stdout.trim().split("\n").at(-1) ?? "";
  return JSON.parse(line);
}

export const cliDevcontainer: Devcontainer = {
  async readConfiguration(workspace, additionalFeatures) {
    const { stdout } = await run(
      process.execPath,
      [CLI, "read-configuration", "--workspace-folder", workspace, "--include-merged-configuration", "--additional-features", JSON.stringify(additionalFeatures), "--log-format", "json"],
      { env: clientEnv(process.env), maxBuffer: MAX_BUFFER },
    );
    const result = lastJsonLine(stdout);
    const configuration = result.configuration;
    const merged = result.mergedConfiguration;
    if (typeof configuration !== "object" || configuration === null || typeof merged !== "object" || merged === null) throw new Error("devcontainer read-configuration returned no configuration");
    const file: unknown = "configFilePath" in configuration ? configuration.configFilePath : undefined;
    const path = typeof file === "object" && file !== null && "fsPath" in file ? file.fsPath : undefined;
    if (typeof path !== "string") throw new Error("devcontainer read-configuration returned no configuration file path");
    return { configuration: { ...configuration }, merged: { ...merged }, configFile: path };
  },

  // --no-env-resolution keeps the env_file paths, so the guardrails can check them.
  async composeConfig(files, projectName) {
    return JSON.parse(await docker(["compose", "--project-name", projectName, ...files.flatMap((file) => ["--file", file]), "config", "--no-env-resolution", "--format", "json"]));
  },

  // COMPOSE_PROJECT_NAME wins over the `name` of the compose file, so the repo cannot choose the project.
  up({ workspace, overrideConfig, idLabel, projectName, additionalFeatures, timeoutMs }) {
    return spawnTail(
      process.execPath,
      [
        CLI,
        "up",
        "--workspace-folder",
        workspace,
        "--override-config",
        overrideConfig,
        "--id-label",
        idLabel,
        "--remove-existing-container",
        "--additional-features",
        JSON.stringify(additionalFeatures),

      ],
      timeoutMs,
      { COMPOSE_PROJECT_NAME: projectName },
    );
  },

  // The container id, not the workspace: exec then reads the config from the container labels that
  // up wrote, never from files that repo code could change after up.
  exec(containerId, command, { env = {}, timeoutMs }) {
    const remoteEnv = Object.entries(env).flatMap(([name, value]) => ["--remote-env", `${name}=${value}`]);
    return spawnTail(process.execPath, [CLI, "exec", "--container-id", containerId, ...remoteEnv, ...command], timeoutMs);
  },

  async cutNetwork(containerId) {
    const mode = await docker(["inspect", "--format", "{{.HostConfig.NetworkMode}}", containerId]);
    if (mode === "host" || mode.startsWith("container:")) throw new Error(`the dev container uses the network of ${mode === "host" ? "the host" : "another container"}, so autopilot cannot cut it`);
    const project = await docker(["inspect", "--format", '{{index .Config.Labels "com.docker.compose.project"}}', containerId]);
    const others = project ? (await docker(["ps", "--all", "--quiet", "--no-trunc", "--filter", `label=com.docker.compose.project=${project}`])).split("\n").filter((id) => id && id !== containerId) : [];
    for (const id of [containerId, ...others]) {
      const networks = (await docker(["inspect", "--format", "{{range $name, $_ := .NetworkSettings.Networks}}{{$name}}\n{{end}}", id])).split("\n").filter(Boolean);
      for (const network of networks) {
        if ((await docker(["network", "inspect", "--format", "{{.Internal}}", network])) === "true") continue;
        await docker(["network", "disconnect", "--force", network, id]);
      }
    }
  },

  async down(idLabel) {
    const ids = (await docker(["ps", "--all", "--quiet", "--filter", `label=${idLabel}`])).split("\n").filter(Boolean);
    for (const id of ids) {
      const project = await docker(["inspect", "--format", '{{index .Config.Labels "com.docker.compose.project"}}', id]);
      if (project) await docker(["compose", "--project-name", project, "down", "--volumes", "--remove-orphans", "--timeout", "5"]);
      else await docker(["rm", "--force", "--volumes", id]);
    }
  },
};
