import { execFile } from "node:child_process";
import { appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { claudeCodeVersion } from "../harness/claude.ts";
import { HARNESSES, runAgent, type Credentials } from "../harness/harness.ts";
import type { Audit } from "./audit.ts";
import { BASELINE_PATH, knownFailureLines, renderBaseline, type Baseline } from "./baseline.ts";
import type { Identity } from "./builder.ts";
import { planChecks } from "./checks.ts";
import { CONFIG_PATH, parseConfig, type Config } from "./config.ts";
import type { Devcontainer } from "./devcontainer-cli.ts";
import { containerName } from "./docker.ts";
import { checkCommand, EnvironmentRefused, RUN_DIR, SECRETS_NAME, shellEnvFile, startEnvironment, stopEnvironment } from "./environment.ts";
import type { GitHub, RepoGitHub } from "./github.ts";
import type { Host } from "./host.ts";
import {
  devcontainerFiles,
  diskFiles,
  ONBOARDING_BRANCH,
  onboardingBody,
  onboardingPrompt,
  parseOnboardingResult,
  readiness,
  renderConfig,
  RESULT_PATH,
  type Onboarding,
  type OnboardingResult,
  type OnboardingRequest,
  type ValidateResult,
} from "./onboarding.ts";
import type { Repo } from "./repo.ts";
import { refusedSecrets } from "./repo-secrets.ts";
import { readSecret } from "./secrets.ts";
import { prepareAgent } from "./skills.ts";
import { pushBranch, readAgentFile, repoUrl, shallowClone, writeRepoFile } from "./workspace.ts";

const exec = promisify(execFile);

export const ONBOARDING_COMMIT = "chore: onboard the repo to autopilot";
const AGENT_TIMEOUT_MINUTES = 20;
const CHECKS_TIMEOUT_MS = 20 * 60 * 1000;
const BASELINE_CHECKS = ["lint", "types"];

const DEFAULT_PLANNER = parseConfig('{ "version": 1 }', "the defaults").agents.planner;

// The host commits here itself: the git config of the host user (signing, hooks) must not apply.
async function git(cwd: string, args: string[]): Promise<string> {
  const env = { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
  const { stdout } = await exec("git", args, { cwd, env, timeout: 5 * 60 * 1000, maxBuffer: 64 * 1024 * 1024 });
  return stdout.trim();
}

export type OnboardingSetup = {
  repo: Repo;
  // init and the host can share one Docker: each removes the containers of its own name.
  jobName: "init" | "onboarding";
  clone: string;
  jobDir: string;
  skillsDir: string;
  configDir: string | undefined;
  skills: string[];
  notes: string | undefined;
  request: OnboardingRequest | undefined;
  credentials: Credentials;
  devcontainer: Devcontainer;
  limits: Host["limits"];
  audit: Audit;
  say: (line: string) => void;
};

async function onboardingAgent(setup: OnboardingSetup, hasDevcontainer: boolean): Promise<OnboardingResult> {
  const { jobDir, repo } = setup;
  const work = join(jobDir, "agent");
  cpSync(setup.clone, work, { recursive: true, verbatimSymlinks: true });
  mkdirSync(join(work, ".autopilot"));
  appendFileSync(join(work, ".git", "info", "exclude"), "/.autopilot/\n");
  const promptFile = join(jobDir, "prompt.md");
  writeFileSync(promptFile, onboardingPrompt({ repo: `${repo.owner}/${repo.name}`, hasDevcontainer, claudeCodeVersion: claudeCodeVersion(), notes: setup.notes, request: setup.request }));
  setup.say(`==> onboarding agent (${DEFAULT_PLANNER.model}), up to ${AGENT_TIMEOUT_MINUTES} minutes`);
  await runAgent({
    harness: HARNESSES[DEFAULT_PLANNER.harness],
    credentials: setup.credentials,
    name: containerName(setup.jobName, repo.owner, repo.name),
    model: DEFAULT_PLANNER.model,
    effort: DEFAULT_PLANNER.effort,
    promptFile,
    skillsDir: setup.skillsDir,
    workdir: work,
    configDir: setup.configDir,
    jobDir,
    limits: setup.limits,
    timeoutMinutes: AGENT_TIMEOUT_MINUTES,
    audit: setup.audit,
  });
  const text = readAgentFile(work, RESULT_PATH, 256 * 1024);
  if (text === undefined) throw new Error(`the onboarding agent wrote no ${RESULT_PATH}`);
  return parseOnboardingResult(text);
}

type Validated = { validate: Onboarding["validate"]; baseline: Baseline };

// The same steps as the checks of a pull request: up (with the install), no network, each command once.
async function validateEnvironment(setup: OnboardingSetup, config: Config): Promise<Validated> {
  const { jobDir, repo, devcontainer, audit, say } = setup;
  // A folder of its own: a repo can be named like the other folders of the job, such as "repo" or "agent".
  const dir = join(jobDir, "checkout", repo.name);
  mkdirSync(join(jobDir, "checkout"));
  cpSync(setup.clone, dir, { recursive: true, verbatimSymlinks: true });
  const runDir = join(jobDir, "run");
  mkdirSync(runDir, { mode: 0o700 });
  const idLabel = `autopilot.job=${containerName(setup.jobName, repo.owner, repo.name)}`;
  const deadline = Date.now() + CHECKS_TIMEOUT_MS;
  say("==> devcontainer up (build, then the install)");
  try {
    const up = await startEnvironment({
      devcontainer,
      workspace: dir,
      idLabel,
      limits: setup.limits,
      mounts: [{ source: runDir, target: RUN_DIR, readonly: true }],
      agentFeature: undefined,
      timeoutMs: deadline - Date.now(),
      audit,
    });
    if (up.kind === "failed") {
      say(up.result.output.split("\n").slice(-20).join("\n"));
      return { validate: { kind: "ran", results: [{ check: "install", outcome: "failed" }] }, baseline: {} };
    }
    await devcontainer.cutNetwork(up.containerId);
    const results: ValidateResult[] = [{ check: "install", outcome: "passed" }];
    const baseline: Baseline = {};
    const refused = refusedSecrets(repo, config.secrets);
    const own = Object.entries(config.secrets).filter(([name]) => !refused.includes(name));
    // Lint output can go into the committed baseline, so only the test check gets the secrets, and it runs last.
    const plans = planChecks(config.verify.required, config.verify.commands).flatMap((plan) => (plan.kind === "command" ? [plan] : []));
    for (const plan of plans.toSorted((a, b) => Number(a.check === "test") - Number(b.check === "test"))) {
      say(`==> ${plan.check}: ${plan.command}`);
      const withSecrets = plan.check === "test" && own.length > 0;
      if (withSecrets) {
        const secrets = Object.fromEntries(own.map(([name, reference]) => [name, readSecret(reference, "onboarding: test check", audit)]));
        writeFileSync(join(runDir, SECRETS_NAME), shellEnvFile(secrets), { mode: 0o600, flag: "wx" });
      }
      const result = await devcontainer.exec(up.containerId, checkCommand(plan.command, up.workspaceFolder, withSecrets), { timeoutMs: deadline - Date.now() });
      const lines = BASELINE_CHECKS.includes(plan.check) && !result.timedOut && !result.truncated ? knownFailureLines(result.output) : [];
      if (result.exit === 0 && !result.timedOut) results.push({ check: plan.check, outcome: "passed" });
      else if (lines.length > 0) {
        baseline[plan.check] = lines;
        results.push({ check: plan.check, outcome: "baseline", lines: lines.length });
      } else results.push({ check: plan.check, outcome: "failed" });
    }
    return { validate: { kind: "ran", results }, baseline };
  } catch (error) {
    if (!(error instanceof EnvironmentRefused)) throw error;
    say(error.message);
    return { validate: { kind: "refused", problems: error.problems }, baseline: {} };
  } finally {
    await stopEnvironment(devcontainer, idLabel, audit);
  }
}

export async function prepareOnboarding(setup: OnboardingSetup): Promise<Omit<Onboarding, "host">> {
  const { clone, repo, say } = setup;
  const files = diskFiles(clone);
  const hasDevcontainer = existsSync(join(clone, ".devcontainer")) || existsSync(join(clone, ".devcontainer.json"));
  say(hasDevcontainer ? "==> the repo has a dev container: the onboarding keeps it" : "==> the repo has no dev container: the onboarding agent writes one");

  const result = await onboardingAgent(setup, hasDevcontainer);
  const rendered: Record<string, string> = { ...devcontainerFiles(result, hasDevcontainer), [CONFIG_PATH]: renderConfig(files.read(CONFIG_PATH), result.commands, setup.skills) };
  if (files.read("AGENTS.md") === undefined) rendered["AGENTS.md"] = `${result.agents_md.trimEnd()}\n`;
  const config = parseConfig(rendered[CONFIG_PATH] ?? "", CONFIG_PATH);
  for (const [path, text] of Object.entries(rendered)) writeRepoFile(clone, path, text);

  const { validate, baseline } = await validateEnvironment(setup, config);
  if (Object.keys(baseline).length > 0) {
    rendered[BASELINE_PATH] = renderBaseline(baseline);
    writeRepoFile(clone, BASELINE_PATH, rendered[BASELINE_PATH]);
  }

  const paths = (await git(clone, ["ls-files", "--cached", "--others", "--exclude-standard"])).split("\n");
  return {
    repo: `${repo.owner}/${repo.name}`,
    merge: config.merge,
    generated: Object.keys(rendered),
    notes: result.notes,
    environment: { ...result.environment, existing: hasDevcontainer },
    validate,
    readiness: readiness(files, paths, config.verify.commands),
  };
}

export type OnboardJob = {
  github: GitHub;
  repoGitHub: RepoGitHub;
  repo: Repo;
  host: Host;
  base: string;
  request: OnboardingRequest;
  identity: Identity;
  credentials: Credentials;
  devcontainer: Devcontainer;
  audit: Audit;
  say: (line: string) => void;
};

// "taken": an onboarding pull request opened while the job ran, so the job did not push.
export type Onboarded = { kind: "pushed"; body: string } | { kind: "taken" };

export async function runOnboarder(job: OnboardJob): Promise<Onboarded> {
  const { repoGitHub, repo, host, identity } = job;
  const missing = HARNESSES[DEFAULT_PLANNER.harness].missingCredential(job.credentials);
  if (missing) throw new Error(missing);
  const jobDir = mkdtempSync(join(tmpdir(), "autopilot-onboarding-"));
  try {
    const clone = join(jobDir, "repo");
    await shallowClone(repo, await repoGitHub.token(), clone, job.base);
    const start = await git(clone, ["rev-parse", "HEAD"]);
    const { skillsDir, claudeConfigDir } = await prepareAgent(host, [], job.github, jobDir);
    const onboarding = await prepareOnboarding({
      repo,
      jobName: "onboarding",
      clone,
      jobDir,
      skillsDir,
      configDir: claudeConfigDir,
      skills: [],
      notes: undefined,
      request: job.request,
      credentials: job.credentials,
      devcontainer: job.devcontainer,
      limits: host.limits,
      audit: job.audit,
      say: job.say,
    });
    await git(clone, ["config", "user.name", identity.name]);
    await git(clone, ["config", "user.email", identity.email]);
    await git(clone, ["add", "--", ...onboarding.generated]);
    await git(clone, ["commit", "--quiet", "-m", ONBOARDING_COMMIT]);
    const head = await git(clone, ["rev-parse", "HEAD"]);
    if ((await repoGitHub.onboardingPull())?.state === "open") return { kind: "taken" };
    // An earlier attempt can have left the branch: this one replaces it.
    await pushBranch(clone, repoUrl(repo), await repoGitHub.token(true), "--force", head, ONBOARDING_BRANCH);
    job.audit({ event: "git.pushed", repo: `${repo.owner}/${repo.name}`, branch: ONBOARDING_BRANCH, head, base: start, commits: 1, force: true });
    return { kind: "pushed", body: onboardingBody({ ...onboarding, host: { kind: "issue", issue: job.request.issue.number } }) };
  } finally {
    rmSync(jobDir, { recursive: true, force: true });
  }
}
