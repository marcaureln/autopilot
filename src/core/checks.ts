import { execFile } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Audit } from "./audit.ts";
import { newFailures, type Baseline } from "./baseline.ts";
import type { Config } from "./config.ts";
import type { Devcontainer } from "./devcontainer-cli.ts";
import { containerName, ensureImage, runContainer, type ContainerResult, type Mount } from "./docker.ts";
import { checkCommand, RUN_DIR, SECRETS_NAME, shellEnvFile, startEnvironment, stopEnvironment } from "./environment.ts";
import type { Host } from "./host.ts";
import type { BotPull } from "./phase.ts";
import type { Repo } from "./repo.ts";
import { refusedSecrets } from "./repo-secrets.ts";
import { readRepoSecrets, readSecret } from "./secrets.ts";
import { shallowClone } from "./workspace.ts";

const exec = promisify(execFile);

const IMAGES = {
  sast: "semgrep/semgrep:1.185.0",
  "deps-scan": "anchore/grype:v0.121.0",
  "secrets-scan": "trufflesecurity/trufflehog:3.95.8",
} as const;

const SEMGREP_RULES_URL = "https://semgrep.dev/c/p/default";
const GRYPE_DB_CACHE: Mount = { source: "autopilot-grype-db", target: "/cache", readonly: false };
const GRYPE_ENV = { GRYPE_DB_CACHE_DIR: "/cache", GRYPE_CHECK_FOR_APP_UPDATE: "false" };
// Anchore builds a new Grype database each day. On a Raspberry Pi its download and import take about
// 4.5 minutes, so the host updates it between jobs, and a job updates it only when it is missing or old.
const GRYPE_DB_UPDATE_INTERVAL_MS = 6 * 60 * 60 * 1000;
const GRYPE_DB_MAX_AGE_MS = 48 * 60 * 60 * 1000;

// The containers run as root on files the host user owns.
const GIT_SAFE_DIRECTORY = { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "safe.directory", GIT_CONFIG_VALUE_0: "*" };

export type CheckResult = { check: string; state: "success" | "failure" | "error"; description: string; output: string };

export type CheckPlan = { check: string; kind: "command"; command: string } | { check: string; kind: "scanner"; scanner: keyof typeof SCANNERS } | { check: string; kind: "missing" };

const SCANNERS = { sast: true, "deps-scan": true, "secrets-scan": true } as const;

function isScanner(check: string): check is keyof typeof SCANNERS {
  return Object.hasOwn(SCANNERS, check);
}

export function planChecks(required: string[], commands: Record<string, string>): CheckPlan[] {
  return required.map((check) => {
    const command = commands[check];
    if (command !== undefined) return { check, kind: "command", command };
    if (isScanner(check)) return { check, kind: "scanner", scanner: check };
    return { check, kind: "missing" };
  });
}

export const HIDDEN_OUTPUT = "(this check runs with the repo secrets: autopilot shows only if it passed)";

export function hideOutput(result: CheckResult): CheckResult {
  if (result.state === "success") return { ...result, description: "passed", output: "" };
  return { ...result, description: result.state === "error" ? "error" : "failed", output: HIDDEN_OUTPUT };
}

export function redact(text: string, values: string[]): string {
  return values
    .filter((value) => value.length > 0)
    .toSorted((a, b) => b.length - a.length)
    .reduce((out, value) => out.replaceAll(value, "***"), text);
}

export function withBaseline(result: CheckResult, run: ContainerResult, known: string[] | undefined): CheckResult {
  if (result.state !== "failure" || known === undefined || run.truncated) return result;
  const fresh = newFailures(run.output, known);
  if (fresh.length > 0) return { ...result, output: `New errors, not in the baseline:\n${fresh.join("\n")}\n\n${result.output}` };
  return { ...result, state: "success", description: "passed: only errors from the baseline" };
}

function resultOf(check: string, run: ContainerResult, failedAs: "failure" | "error" = "failure"): CheckResult {
  if (run.timedOut) return { check, state: "error", description: "timed out", output: run.output };
  if (run.exit === 0) return { check, state: "success", description: "passed", output: run.output };
  return { check, state: failedAs, description: `failed (exit ${run.exit})`, output: run.output };
}

// The input is the result of `grype db status --output json`.
export function grypeDbFresh(status: { exit: number; output: string }, now: number): boolean {
  if (status.exit !== 0 || !/"valid":\s*true/.test(status.output)) return false;
  const built = /"built":\s*"([^"]+)"/.exec(status.output)?.[1];
  return built !== undefined && now - Date.parse(built) < GRYPE_DB_MAX_AGE_MS;
}

// The run loop runs this when no job runs. A failed update waits for the next interval: the jobs
// still update a database that is missing or old.
export function grypeDbUpdater(limits: Host["limits"], audit: Audit): { due: () => boolean; run: () => Promise<void> } {
  let last = 0;
  return {
    due: () => Date.now() - last >= GRYPE_DB_UPDATE_INTERVAL_MS,
    async run() {
      last = Date.now();
      const failure = await ensureImage(IMAGES["deps-scan"])
        .then(() =>
          runContainer({
            name: containerName("grype-db"),
            image: IMAGES["deps-scan"],
            command: ["db", "update"],
            mounts: [GRYPE_DB_CACHE],
            network: "bridge",
            env: GRYPE_ENV,
            limits,
            timeoutMs: 15 * 60 * 1000,
            audit,
          }),
        )
        .then(
          (result) => (result.exit !== 0 || result.timedOut ? result.output.slice(-500) : undefined),
          (error: unknown) => (error instanceof Error ? error.message : String(error)),
        );
      // The loop goes on: an error here must not stop the service.
      if (failure !== undefined) console.error(`could not update the Grype database: ${failure}`);
    },
  };
}

export const GRYPE_IMAGE = IMAGES["deps-scan"];
export const GRYPE_DB_VOLUME = GRYPE_DB_CACHE.source;

// Jobs that run together share the database volume: one checks and updates it at a time.
let grypeDbLock: Promise<unknown> = Promise.resolve();

export type ChecksJob = {
  repo: Repo;
  defaultBranchBaseline: Baseline;
  token: string;
  pull: BotPull;
  commits: number;
  host: Host;
  config: Config;
  devcontainer: Devcontainer;
  audit: Audit;
};

export async function runChecks(job: ChecksJob): Promise<CheckResult[]> {
  const { repo, pull, host, config, devcontainer, audit } = job;
  const deadline = Date.now() + config.verify.timeout_minutes * 60 * 1000;
  const jobDir = mkdtempSync(join(tmpdir(), "autopilot-checks-"));
  const src = join(jobDir, "src");
  const name = (step: string) => containerName(repo.owner, repo.name, pull.number, step);
  const idLabel = `autopilot.job=${name("checks")}`;
  let started = false;
  const container = (
    step: string,
    image: string,
    command: string[],
    mounts: Mount[],
    options: { network?: "none" | "bridge"; env?: Record<string, string>; secrets?: Record<string, string>; entrypoint?: string } = {},
  ) =>
    runContainer({
      name: name(step),
      image,
      command,
      mounts,
      network: options.network ?? "none",
      env: options.env,
      secrets: options.secrets,
      entrypoint: options.entrypoint,
      limits: host.limits,
      timeoutMs: deadline - Date.now(),
      audit,
    });
  // Each scanner gets its own copy, so one check cannot change what the next one sees. The commands
  // share the copy in the dev container: they run one after the other in it.
  const copy = (step: string) => {
    const dir = join(jobDir, step);
    cpSync(src, dir, { recursive: true, verbatimSymlinks: true });
    return dir;
  };

  try {
    await shallowClone(repo, job.token, src, pull.head.ref, job.commits + 1);
    const { stdout: head } = await exec("git", ["rev-parse", "HEAD"], { cwd: src });
    if (head.trim() !== pull.head.sha) throw new Error(`the branch moved to ${head.trim().slice(0, 7)} while the checks started`);
    const { stdout: baseline } = await exec("git", ["rev-parse", `HEAD~${job.commits}`], { cwd: src });

    let secrets: Record<string, string> = {};
    let environment: { kind: "ready"; containerId: string; workspaceFolder: string } | { kind: "failed"; result: CheckResult } | undefined;
    const openEnvironment = async (): Promise<NonNullable<typeof environment>> => {
      const refused = refusedSecrets(repo, config.secrets);
      if (refused.length > 0) throw new Error(`the secrets ${refused.join(", ")} point outside the repo's own 1Password item`);
      const reason = `checks: ${repo.owner}/${repo.name}#${pull.number}`;
      // A reference in the config wins over a value of the same name in the repo's env file.
      secrets = { ...readRepoSecrets(repo, reason, audit), ...Object.fromEntries(Object.entries(config.secrets).map(([key, reference]) => [key, readSecret(reference, reason, audit)])) };
      const runDir = join(jobDir, "run");
      mkdirSync(runDir, { mode: 0o700 });
      started = true;
      // `devcontainer up` runs the repo's install (its lifecycle commands) with the network on.
      const up = await startEnvironment({
        devcontainer,
        workspace: copy(repo.name),
        idLabel,
        limits: host.limits,
        mounts: [{ source: runDir, target: RUN_DIR, readonly: true }],
        agentFeature: undefined,
        timeoutMs: deadline - Date.now(),
        audit,
      });
      if (up.kind === "failed") return { kind: "failed", result: { ...resultOf("install", up.result, "error"), description: "the dev container or its install failed" } };
      // The checks run repository code with the secrets: no network, only the compose services.
      await devcontainer.cutNetwork(up.containerId);
      if (Object.keys(secrets).length > 0) writeFileSync(join(runDir, SECRETS_NAME), shellEnvFile(secrets), { mode: 0o600, flag: "wx" });
      return { kind: "ready", containerId: up.containerId, workspaceFolder: up.workspaceFolder };
    };
    const results: CheckResult[] = [];
    for (const plan of planChecks(config.verify.required, config.verify.commands)) {
      if (Date.now() >= deadline) {
        results.push({ check: plan.check, state: "error", description: `the ${config.verify.timeout_minutes}-minute limit ran out`, output: "" });
        continue;
      }
      if (plan.kind === "missing") throw new Error(`verify.required lists ${plan.check}, which has no command`);
      if (plan.kind === "command") {
        environment ??= await openEnvironment();
        if (environment.kind === "failed") {
          results.push({ ...environment.result, check: plan.check });
          continue;
        }
        const withSecrets = Object.keys(secrets).length > 0;
        const run = await devcontainer.exec(environment.containerId, checkCommand(plan.command, environment.workspaceFolder, withSecrets), { timeoutMs: deadline - Date.now() });
        const result = withBaseline(resultOf(plan.check, run), run, job.defaultBranchBaseline[plan.check]);
        results.push(withSecrets ? hideOutput(result) : result);
        continue;
      }
      await ensureImage(IMAGES[plan.scanner]);
      results.push(await SCAN[plan.scanner]({ dir: copy(plan.check), baseline: baseline.trim(), jobDir, container }));
    }
    const values = Object.values(secrets);
    return results.map((result) => ({ ...result, output: redact(result.output, values) }));
  } finally {
    if (started) await stopEnvironment(devcontainer, idLabel, audit).catch((error: unknown) => console.error(`could not remove the dev container ${idLabel}: ${error instanceof Error ? error.message : String(error)}`));
    rmSync(jobDir, { recursive: true, force: true });
  }
}

type Scan = (input: {
  dir: string;
  baseline: string;
  jobDir: string;
  container: (step: string, image: string, command: string[], mounts: Mount[], options?: { network?: "none" | "bridge"; env?: Record<string, string>; entrypoint?: string }) => Promise<ContainerResult>;
}) => Promise<CheckResult>;

// Semgrep and Grype need rules and a vulnerability database from the network. The host fetches
// those first, so the scans themselves run with no network. TruffleHog is the exception: it
// verifies a secret by calling its provider. It runs no repository code, and its container holds no
// token, only the repository that is already on GitHub.
const SCAN: Record<keyof typeof SCANNERS, Scan> = {
  async sast({ dir, baseline, jobDir, container }) {
    const response = await fetch(SEMGREP_RULES_URL, { signal: AbortSignal.timeout(60_000) });
    // An infrastructure failure is not a code failure: it must not use up a fix round, so the next loop retries.
    if (!response.ok) throw new Error(`could not fetch the Semgrep rules (HTTP ${response.status})`);
    const rules = join(jobDir, "rules");
    mkdirSync(rules);
    writeFileSync(join(rules, "default.yml"), await response.text());
    const run = await container(
      "sast",
      IMAGES.sast,
      ["semgrep", "scan", "--config", "/rules/default.yml", "--baseline-commit", baseline, "--error", "--disable-nosem", "--metrics", "off", "--disable-version-check", "--quiet"],
      [
        { source: dir, target: "/src", readonly: false },
        { source: rules, target: "/rules", readonly: true },
      ],
      { env: GIT_SAFE_DIRECTORY },
    );
    return resultOf("sast", run);
  },
  async "deps-scan"({ dir, container }) {
    const ready = grypeDbLock.then(async () => {
      const status = await container("grype-db-status", IMAGES["deps-scan"], ["db", "status", "--output", "json"], [GRYPE_DB_CACHE], { env: GRYPE_ENV });
      if (grypeDbFresh(status, Date.now())) return;
      const update = await container("grype-db", IMAGES["deps-scan"], ["db", "update"], [GRYPE_DB_CACHE], { network: "bridge", env: GRYPE_ENV });
      if (update.exit !== 0 || update.timedOut) throw new Error(`could not update the Grype database: ${update.output.slice(-500)}`);
    });
    grypeDbLock = ready.catch(() => undefined);
    await ready;
    const run = await container("deps-scan", IMAGES["deps-scan"], ["dir:/src", "--only-fixed", "--fail-on", "high"], [{ source: dir, target: "/src", readonly: true }, GRYPE_DB_CACHE], {
      env: { ...GRYPE_ENV, GRYPE_DB_AUTO_UPDATE: "false" },
    });
    return resultOf("deps-scan", run);
  },
  async "secrets-scan"({ dir, baseline, container }) {
    const run = await container(
      "secrets-scan",
      IMAGES["secrets-scan"],
      ["git", "file:///src", "--since-commit", baseline, "--branch", "HEAD", "--results=verified", "--fail", "--no-update"],
      [{ source: dir, target: "/src", readonly: true }],
      // The image's entrypoint script splits its last argument through a shell, so autopilot calls the binary directly.
      { network: "bridge", env: GIT_SAFE_DIRECTORY, entrypoint: "/usr/bin/trufflehog" },
    );
    return resultOf("secrets-scan", run);
  },
};
