import type { Config } from "./config.ts";
import { GRYPE_DB_MAX_AGE_MS, planChecks } from "./checks.ts";
import { containerName } from "./docker.ts";
import type { Quota } from "./github.ts";
import { GIB, MIN_DISK, RELEASE_TAG } from "./setup.ts";
import { LABELS } from "./state.ts";

export type Verdict = { status: "ok"; note?: string } | { status: "warn" | "fail"; problem: string; fix: string };

// The exit code of doctor-host when a check failed. Any other failure code means that it did not run.
export const CHECKS_FAILED = 2;

export type Check = { name: string; run: () => Promise<Verdict> };

export const ok = (note?: string): Verdict => ({ status: "ok", ...(note !== undefined && { note }) });
export const warn = (problem: string, fix: string): Verdict => ({ status: "warn", problem, fix });
export const fail = (problem: string, fix: string): Verdict => ({ status: "fail", problem, fix });
export const skipped = (reason: string): Verdict => ok(`skipped, ${reason}`);

const STATUS_LABELS = { ok: "OK  ", warn: "WARN", fail: "FAIL" };

export function formatResult(name: string, verdict: Verdict): string[] {
  const label = STATUS_LABELS[verdict.status];
  if (verdict.status === "ok") return [`${label}  ${name}${verdict.note === undefined ? "" : `: ${verdict.note}`}`];
  return [`${label}  ${name}`, ...verdict.problem.split("\n").map((line) => `      ${line}`), `      fix: ${verdict.fix}`];
}

export async function runDoctor(checks: Check[], print: (line: string) => void): Promise<number> {
  let failed = 0;
  for (const check of checks) {
    const verdict = await check.run().catch((error: unknown) => fail(error instanceof Error ? error.message : String(error), "fix the cause above, then run autopilot doctor again"));
    if (verdict.status === "fail") failed++;
    for (const line of formatResult(check.name, verdict)) print(line);
  }
  return failed;
}

const gib = (bytes: number): string => `${(bytes / GIB).toFixed(1)} GiB`;

// Docker reads "6g" as 6 GiB.
const MEMORY_UNITS: Record<string, number> = { k: 1024, m: 1024 ** 2, g: GIB };

export function memoryBytes(value: string): number {
  const [, amount, unit] = /^(\d+)([kmg])$/.exec(value) ?? [];
  const bytes = MEMORY_UNITS[unit ?? ""];
  if (amount === undefined || bytes === undefined) throw new Error(`"${value}" is not a memory size such as 6g`);
  return Number(amount) * bytes;
}

export function memoryVerdict(totalBytes: number, limit: string, concurrency: number, hostFile: string): Verdict {
  const needed = memoryBytes(limit) * concurrency;
  if (needed <= totalBytes) return ok(`${gib(totalBytes)} for ${concurrency} x ${limit}`);
  return fail(`limits.memory ${limit} x concurrency ${concurrency} is ${gib(needed)}, but the host has ${gib(totalBytes)} of memory`, `lower concurrency or limits.memory in ${hostFile}, then run autopilot start`);
}

export function diskVerdict(freeBytes: number): Verdict {
  if (freeBytes >= MIN_DISK) return ok(`${gib(freeBytes)} free`);
  return fail(`the host has ${gib(freeBytes)} of free disk: the images and worktrees need about ${gib(MIN_DISK)}`, "free space on the host, for example with docker image prune --all");
}

function isNewer(a: string, b: string): boolean {
  const parts = (tag: string) => tag.slice(1).split(".").map(Number);
  const [left, right] = [parts(a), parts(b)];
  for (const [index, value] of left.entries()) {
    if (value !== right[index]) return value > (right[index] ?? 0);
  }
  return false;
}

export function releaseVerdict(client: string | undefined, host: string, target: string): Verdict {
  if (!RELEASE_TAG.test(host)) return ok(`the host runs the checkout build ${host}`);
  if (client === undefined) return ok(`the host runs ${host}, this client runs from a checkout`);
  if (client === host) return ok(host);
  const problem = `this client is ${client}, the host runs ${host}`;
  return fail(problem, isNewer(host, client) ? `autopilot self-update --version ${host}` : `autopilot update --host ${target} --version ${client}`);
}

const LOW_QUOTA = 0.1;

export function quotaVerdict(quotas: { core: Quota; search: Quota }): Verdict {
  for (const [name, quota] of Object.entries(quotas)) {
    if (quota.remaining < quota.limit * LOW_QUOTA) {
      return fail(`the ${name} quota has ${quota.remaining} of ${quota.limit} calls left until ${quota.resetAt.toISOString()}`, "wait for the reset (the host polls again by itself), or stop the host until then with autopilot stop");
    }
  }
  return ok(`core ${quotas.core.remaining}/${quotas.core.limit}, search ${quotas.search.remaining}/${quotas.search.limit}`);
}

export function labelsVerdict(existing: string[], repo: string): Verdict {
  const missing = LABELS.filter((label) => !existing.includes(label.name));
  if (missing.length === 0) return ok();
  return warn(
    `missing labels: ${missing.map((label) => label.name).join(", ")}`,
    missing.map((label) => `gh label create ${label.name} --repo ${repo} --color ${label.color} --description "${label.description}"`).join("; "),
  );
}

// A host check run is named after the `name` of its job, else after the job id.
export function workflowJobNames(text: string): string[] {
  const names: string[] = [];
  let inJobs = false;
  let jobIndent: number | undefined;
  let propertyIndent: number | undefined;
  for (const line of text.split("\n")) {
    const content = line.trim();
    if (content === "" || content.startsWith("#")) continue;
    const indent = line.length - line.trimStart().length;
    if (indent === 0) {
      inJobs = /^jobs:\s*(#.*)?$/.test(line);
      continue;
    }
    if (!inJobs) continue;
    jobIndent ??= indent;
    const key = /^([\w-]+):/.exec(content)?.[1];
    if (indent === jobIndent && key) {
      names.push(key);
      propertyIndent = undefined;
      continue;
    }
    propertyIndent ??= indent;
    if (indent !== propertyIndent) continue;
    const name = /^name:\s*(?:(["'])(.*?)\1|(.*?))\s*(?:\s#.*)?$/.exec(content);
    const value = name?.[2] ?? name?.[3];
    if (value) names[names.length - 1] = value;
  }
  return names;
}

// A matrix job runs as "name (value)".
export function missingCiJobs(required: string[], jobs: string[]): string[] {
  return required.filter((name) => !jobs.some((job) => job === name || name.startsWith(`${job} (`)));
}

export function ciJobsVerdict(config: Config, jobs: string[]): Verdict {
  if (config.verify.mode !== "ci") return ok("verify.mode is host");
  const missing = missingCiJobs(config.verify.required, jobs);
  if (missing.length === 0) return ok();
  return fail(`verify.required names no job in .github/workflows/: ${missing.join(", ")}`, "name a job of a workflow after each one, or change verify.required in .github/autopilot.json");
}

export function checkCommandsVerdict(config: Config): Verdict {
  if (config.verify.mode !== "host") return ok("verify.mode is ci");
  const missing = planChecks(config.verify.required, config.verify.commands)
    .filter((plan) => plan.kind === "missing")
    .map((plan) => plan.check);
  if (missing.length === 0) return ok();
  return fail(`verify.required has no command for: ${missing.join(", ")}`, `add ${missing.map((name) => `"${name}"`).join(", ")} to verify.commands in .github/autopilot.json`);
}

// With the Workflows permission the App can push a change to a workflow. GitHub runs it as soon as
// it is pushed, with the secrets of the repo, before anyone reviews it.
export function workflowSecretsVerdict(canChangeWorkflows: boolean, actionsSecrets: number | undefined): Verdict {
  if (!canChangeWorkflows) return ok("the App cannot change workflows");
  if (actionsSecrets === undefined) return skipped("the client could not list the Actions secrets of the repo: gh needs admin access to it");
  if (actionsSecrets === 0) return ok("the repo has no Actions secrets");
  return warn(
    `the App can change workflows and the repo has ${actionsSecrets} Actions secrets: a changed workflow runs with them before review`,
    "move the secrets to a GitHub Environment with required reviewers (Settings, Environments), and name that environment in the jobs that need them",
  );
}

// The host and the jobs both update the database in a container of this name. They write its exit to the audit trail.
const HOUR_MS = 60 * 60 * 1000;
const GRYPE_DB_UPDATE_CONTAINER = containerName("grype-db");

export function grypeDbVerdict(auditLines: string[], now: number): Verdict {
  const updates = auditLines
    .filter((line) => line.startsWith("{"))
    .map((line): { at?: string; event?: string; name?: string; exit?: number } => JSON.parse(line))
    .filter((entry) => entry.event === "container.ended" && entry.name === GRYPE_DB_UPDATE_CONTAINER && entry.exit === 0)
    .map((entry) => Date.parse(entry.at ?? ""))
    .filter((time) => !Number.isNaN(time));
  if (updates.length === 0) return warn("the audit trail has no successful Grype database update", "autopilot start: the service updates the database when it is idle");
  const ageMs = now - Math.max(...updates);
  const hours = Math.floor(ageMs / HOUR_MS);
  const age = hours < 1 ? "less than 1 h" : `${hours} h`;
  if (ageMs >= GRYPE_DB_MAX_AGE_MS) return fail(`the Grype database was last updated ${age} ago, and the limit is ${GRYPE_DB_MAX_AGE_MS / HOUR_MS} h`, "autopilot start, then read autopilot logs if the update fails");
  return ok(`updated ${age} ago`);
}
