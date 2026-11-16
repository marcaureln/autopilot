import { execFile } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Audit } from "./audit.ts";
import type { Config } from "./config.ts";
import { containerName, ensurePulled, runContainer, type ContainerResult, type Mount } from "./docker.ts";
import type { Host } from "./host.ts";
import type { BotPull } from "./phase.ts";
import type { Repo } from "./repo.ts";
import { readSecret } from "./secrets.ts";
import { shallowClone } from "./workspace.ts";

const exec = promisify(execFile);

export const IMAGES = {
  node: "node:26.13.1-slim",
  sast: "semgrep/semgrep:1.185.0",
  "deps-scan": "anchore/grype:v0.121.0",
  "secrets-scan": "trufflesecurity/trufflehog:3.95.8",
} as const;

const SEMGREP_RULES_URL = "https://semgrep.dev/c/p/default";
const GRYPE_DB_VOLUME = "autopilot-grype-db";

// The containers run as root on files the host user owns.
const GIT_SAFE_DIRECTORY = { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "safe.directory", GIT_CONFIG_VALUE_0: "*" };

export type CheckResult = { check: string; state: "success" | "failure" | "error"; description: string; output: string };

export type CheckPlan = { check: string; kind: "stack"; command: string } | { check: string; kind: "scanner"; scanner: keyof typeof SCANNERS } | { check: string; kind: "missing" };

const SCANNERS = { sast: true, "deps-scan": true, "secrets-scan": true } as const;

function isScanner(check: string): check is keyof typeof SCANNERS {
  return Object.hasOwn(SCANNERS, check);
}

export function planChecks(required: string[], commands: Record<string, string>): CheckPlan[] {
  return required.map((check) => {
    const command = commands[check];
    if (command !== undefined) return { check, kind: "stack", command };
    if (isScanner(check)) return { check, kind: "scanner", scanner: check };
    return { check, kind: "missing" };
  });
}

export function nodeInstallCommand(files: (name: string) => boolean): string | undefined {
  if (files("package-lock.json") || files("npm-shrinkwrap.json")) return "npm ci";
  if (files("pnpm-lock.yaml")) return "npm install --global pnpm && pnpm install --frozen-lockfile";
  if (files("yarn.lock")) return "npm install --global yarn && yarn install --frozen-lockfile";
  if (files("package.json")) return "npm install";
  return undefined;
}

// Check output goes to the builder prompt and to issue comments.
export function redact(text: string, values: string[]): string {
  return values
    .filter((value) => value.length > 0)
    .toSorted((a, b) => b.length - a.length)
    .reduce((out, value) => out.replaceAll(value, "***"), text);
}

function resultOf(check: string, run: ContainerResult, failedAs: "failure" | "error" = "failure"): CheckResult {
  if (run.timedOut) return { check, state: "error", description: "timed out", output: run.output };
  if (run.exit === 0) return { check, state: "success", description: "passed", output: run.output };
  return { check, state: failedAs, description: `failed (exit ${run.exit})`, output: run.output };
}

export type ChecksJob = {
  repo: Repo;
  token: string;
  pull: BotPull;
  commits: number;
  host: Host;
  config: Config;
  audit: Audit;
};

export async function runChecks(job: ChecksJob): Promise<CheckResult[]> {
  const { repo, pull, host, config, audit } = job;
  const deadline = Date.now() + config.verify.timeout_minutes * 60 * 1000;
  const jobDir = mkdtempSync(join(tmpdir(), "autopilot-checks-"));
  const src = join(jobDir, "src");
  const name = (step: string) => containerName(repo.owner, repo.name, pull.number, step);
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
  // Each container gets its own copy, so one check cannot change what the next one sees.
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

    let stackDir: string | undefined;
    let installFailure: CheckResult | undefined;
    // Only the stack checks get the values: they run with no network, after the install.
    let secrets: Record<string, string> = {};
    const results: CheckResult[] = [];
    for (const plan of planChecks(config.verify.required, config.verify.commands)) {
      if (Date.now() >= deadline) {
        results.push({ check: plan.check, state: "error", description: `the ${config.verify.timeout_minutes}-minute limit ran out`, output: "" });
        continue;
      }
      if (plan.kind === "missing") throw new Error(`verify.required lists ${plan.check}, which has no command`);
      if (plan.kind === "stack") {
        if (!stackDir) {
          secrets = Object.fromEntries(
            Object.entries(config.secrets).map(([key, reference]) => [key, readSecret(reference, `checks: ${repo.owner}/${repo.name}#${pull.number}`, audit)]),
          );
          stackDir = copy("stack");
          await ensurePulled(IMAGES.node);
          const dir = stackDir;
          const install = nodeInstallCommand((file) => existsSync(join(dir, file)));
          if (install) {
            const run = await container("install", IMAGES.node, ["sh", "-c", install], [{ source: dir, target: "/work", readonly: false }], { network: "bridge" });
            if (run.exit !== 0 || run.timedOut) installFailure = { ...resultOf("install", run, "error"), description: `dependency install failed: ${install}` };
          }
        }
        if (installFailure) {
          results.push({ ...installFailure, check: plan.check });
          continue;
        }
        const run = await container(plan.check, IMAGES.node, ["sh", "-c", `cd /work && ${plan.command}`], [{ source: stackDir, target: "/work", readonly: false }], { secrets });
        results.push(resultOf(plan.check, run));
        continue;
      }
      await ensurePulled(IMAGES[plan.scanner]);
      results.push(await SCAN[plan.scanner]({ dir: copy(plan.check), baseline: baseline.trim(), jobDir, container }));
    }
    const values = Object.values(secrets);
    return results.map((result) => ({ ...result, output: redact(result.output, values) }));
  } finally {
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
    const cache = { source: GRYPE_DB_VOLUME, target: "/cache", readonly: false };
    const env = { GRYPE_DB_CACHE_DIR: "/cache", GRYPE_CHECK_FOR_APP_UPDATE: "false" };
    const update = await container("grype-db", IMAGES["deps-scan"], ["db", "update"], [cache], { network: "bridge", env });
    if (update.exit !== 0 || update.timedOut) throw new Error(`could not update the Grype database: ${update.output.slice(-500)}`);
    const run = await container("deps-scan", IMAGES["deps-scan"], ["dir:/src", "--only-fixed", "--fail-on", "high"], [{ source: dir, target: "/src", readonly: true }, cache], {
      env: { ...env, GRYPE_DB_AUTO_UPDATE: "false" },
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
