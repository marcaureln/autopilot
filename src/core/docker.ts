import { execFile, spawn } from "node:child_process";
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
  // Sent to docker through a pipe as an env file, never in the arguments or the docker client environment.
  secrets?: Record<string, string>;
  limits: Host["limits"];
  timeoutMs: number;
  audit: Audit;
};

export type ContainerResult = { exit: number; timedOut: boolean; output: string };

const OUTPUT_TAIL = 16_000;

const CLIENT_ENV = ["PATH", "HOME", "USER", "LANG", "TMPDIR", "XDG_RUNTIME_DIR", "XDG_CONFIG_HOME", "DOCKER_HOST", "DOCKER_CONTEXT", "DOCKER_CONFIG", "DOCKER_CERT_PATH", "DOCKER_TLS_VERIFY"];

// The docker client gets only what it needs to reach the daemon, not the environment of the host process.
export function clientEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(CLIENT_ENV.flatMap((name) => (env[name] === undefined ? [] : [[name, env[name]]])));
}

export async function runContainer(job: ContainerRun): Promise<ContainerResult> {
  const secretNames = Object.keys(job.secrets ?? {});
  const envFileText = envFile(job.secrets ?? {});
  await run("docker", ["rm", "--force", job.name]).catch(() => undefined);
  const args = [
    "run",
    "--rm",
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
    ...Object.entries(job.env ?? {}).flatMap(([name, value]) => ["--env", `${name}=${value}`]),
    ...(secretNames.length > 0 ? ["--env-file", "/dev/fd/3"] : []),
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
    env: [...Object.keys(job.env ?? {}), ...secretNames],
    caps: { memory: job.limits.memory, cpus: job.limits.cpus, pids: job.limits.pids, timeout_seconds: Math.round(job.timeoutMs / 1000), cap_drop: "ALL", network: job.network },
  });
  const started = Date.now();
  const child = spawn("docker", args, { stdio: ["ignore", "pipe", "pipe", "pipe"], env: clientEnv(process.env) });
  const [, stdout, stderr, secretsPipe] = child.stdio;
  if (!stdout || !stderr || !secretsPipe || !("end" in secretsPipe)) throw new Error("docker: the pipes did not open");
  // docker can exit before it reads the pipe; its exit code reports why.
  secretsPipe.on("error", () => undefined);
  secretsPipe.end(envFileText);
  let output = "";
  const append = (chunk: Buffer) => (output = (output + chunk.toString()).slice(-OUTPUT_TAIL));
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
  }).finally(() => clearTimeout(timer));
  job.audit({ event: "container.ended", name: job.name, exit, timed_out: timedOut, duration_seconds: Math.round((Date.now() - started) / 1000) });
  return { exit, timedOut, output: output.trim() };
}

export async function ensurePulled(image: string): Promise<void> {
  const present = await run("docker", ["image", "inspect", image]).then(
    () => true,
    () => false,
  );
  if (!present) await run("docker", ["pull", "--quiet", image], { maxBuffer: 16 * 1024 * 1024 });
}

// Container names allow only these characters.
export function containerName(...parts: (string | number)[]): string {
  return ["autopilot", ...parts].join("-").toLowerCase().replace(/[^a-z0-9_.-]/g, "-");
}
