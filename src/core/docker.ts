import { execFile, spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Audit } from "./audit.ts";
import type { Host } from "./host.ts";
import { envFile } from "./repo-secrets.ts";

const run = promisify(execFile);

export type Mount = { source: string; target: string; readonly: boolean };

export type ContainerRun = {
  name: string;
  image: string;
  entrypoint?: string;
  command: string[];
  mounts: Mount[];
  // "none" for anything that runs repository code.
  network: "none" | "bridge";
  // Never a secret: the docker run arguments are in the process list.
  env?: Record<string, string>;
  // Secret values for the docker client's own environment. Docker copies each one into the container
  // by name, so the value stays out of the process list.
  passthroughEnv?: Record<string, string>;
  secrets?: Record<string, string>;
  // Written to the container's stdin.
  input?: Buffer;
  limits: Host["limits"];
  timeoutMs: number;
  audit: Audit;
};

export type ContainerResult = { exit: number; timedOut: boolean; output: string; truncated: boolean };

const OUTPUT_TAIL = 16_000;

const CLIENT_ENV = ["PATH", "HOME", "USER", "LANG", "TMPDIR", "XDG_RUNTIME_DIR", "XDG_CONFIG_HOME", "DOCKER_HOST", "DOCKER_CONTEXT", "DOCKER_CONFIG", "DOCKER_CERT_PATH", "DOCKER_TLS_VERIFY"];

export function clientEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(CLIENT_ENV.flatMap((name) => (env[name] === undefined ? [] : [[name, env[name]]])));
}

export async function runContainer(job: ContainerRun): Promise<ContainerResult> {
  const secretNames = Object.keys(job.secrets ?? {});
  // A private 0700 folder with a 0600 file: Linux cannot open Node's fd 3 socket as /dev/fd/3.
  const secretsDir = secretNames.length > 0 ? mkdtempSync(join(tmpdir(), "autopilot-env-")) : undefined;
  const secretsFile = secretsDir && join(secretsDir, "env");
  if (secretsFile) writeFileSync(secretsFile, envFile(job.secrets ?? {}), { mode: 0o600, flag: "wx" });
  await run("docker", ["rm", "--force", job.name]).catch(() => undefined);
  const args = [
    "run",
    "--rm",
    ...(job.input === undefined ? [] : ["--interactive"]),
    "--name",
    job.name,
    "--network",
    job.network,
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
    ...Object.keys(job.passthroughEnv ?? {}).flatMap((name) => ["--env", name]),
    ...Object.entries(job.env ?? {}).flatMap(([name, value]) => ["--env", `${name}=${value}`]),
    ...(secretsFile ? ["--env-file", secretsFile] : []),
    ...job.mounts.flatMap(({ source, target, readonly }) => ["--volume", `${source}:${target}${readonly ? ":ro" : ""}`]),
    ...(job.entrypoint === undefined ? [] : ["--entrypoint", job.entrypoint]),
    job.image,
    ...job.command,
  ];

  job.audit({
    event: "container.started",
    name: job.name,
    image: job.image,
    mounts: job.mounts.map((mount) => `${mount.target}${mount.readonly ? ":ro" : ""}`),
    env: [...Object.keys(job.passthroughEnv ?? {}), ...Object.keys(job.env ?? {}), ...secretNames],
    caps: { memory: job.limits.memory, cpus: job.limits.cpus, pids: job.limits.pids, timeout_seconds: Math.round(job.timeoutMs / 1000), cap_drop: "ALL", network: job.network },
  });
  const started = Date.now();
  const child = spawn("docker", args, { stdio: ["pipe", "pipe", "pipe"], env: { ...clientEnv(process.env), ...job.passthroughEnv } });
  const { stdin, stdout, stderr } = child;
  stdin.end(job.input);
  let output = "";
  let truncated = false;
  const append = (chunk: Buffer) => {
    output += chunk.toString();
    if (output.length > OUTPUT_TAIL) {
      output = output.slice(-OUTPUT_TAIL);
      truncated = true;
    }
  };
  stdout.on("data", append);
  stderr.on("data", append);

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    void run("docker", ["kill", job.name]).catch(() => undefined);
  }, Math.max(job.timeoutMs, 1000));
  const exit = await new Promise<number>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => resolve(code ?? 1));
  }).finally(() => {
    clearTimeout(timer);
    if (secretsDir) rmSync(secretsDir, { recursive: true, force: true });
  });
  job.audit({ event: "container.ended", name: job.name, exit, timed_out: timedOut, duration_seconds: Math.round((Date.now() - started) / 1000) });
  return { exit, timedOut, output: output.trim(), truncated };
}

// An image with a build context is built from it. Any other image is pulled.
export async function ensureImage(image: string, buildContext?: string): Promise<void> {
  const present = await run("docker", ["image", "inspect", image]).then(
    () => true,
    () => false,
  );
  if (present) return;
  const args = buildContext === undefined ? ["pull", "--quiet", image] : ["build", "--quiet", "--tag", image, buildContext];
  await run("docker", args, { maxBuffer: 16 * 1024 * 1024 });
}

// Container names allow only these characters.
export function containerName(...parts: (string | number)[]): string {
  return ["autopilot", ...parts].join("-").toLowerCase().replace(/[^a-z0-9_.-]/g, "-");
}
