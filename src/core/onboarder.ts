import { execFile } from "node:child_process";
import { appendFileSync, cpSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { claudeCodeVersion } from "../harness/claude.ts";
import { HARNESSES, runAgent, type Credentials } from "../harness/harness.ts";
import type { Audit } from "./audit.ts";
import { BASELINE_PATH, knownFailureLines, renderBaseline, type Baseline } from "./baseline.ts";
import { planChecks } from "./checks.ts";
import { CONFIG_PATH, parseConfig, type Config } from "./config.ts";
import type { Devcontainer } from "./devcontainer-cli.ts";
import { containerName } from "./docker.ts";
import { checkCommand, EnvironmentRefused, RUN_DIR, SECRETS_NAME, shellEnvFile, startEnvironment, stopEnvironment } from "./environment.ts";
import type { Host } from "./host.ts";
import {
  devcontainerFiles,
  diskFiles,
  onboardingPrompt,
  parseOnboardingResult,
  readiness,
  renderConfig,
  RESULT_PATH,
  type Onboarding,
  type OnboardingResult,
  type ValidateResult,
} from "./onboarding.ts";
import type { Repo } from "./repo.ts";
import { refusedSecrets } from "./repo-secrets.ts";
import { readSecret } from "./secrets.ts";
import { readAgentFile, writeRepoFile } from "./workspace.ts";

const exec = promisify(execFile);

export const ONBOARDING_COMMIT = "chore: onboard the repo to autopilot";
const AGENT_TIMEOUT_MINUTES = 20;
const CHECKS_TIMEOUT_MS = 20 * 60 * 1000;
const BASELINE_CHECKS = ["lint", "types"];

// The repo has no config yet, so the agent is the default planner.
const AGENT = parseConfig('{ "version": 1 }', "the defaults").agents.planner;

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await exec("git", args, { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" }, maxBuffer: 64 * 1024 * 1024 });
  return stdout.trim();
}

export type OnboardingSetup = {
  repo: Repo;
  // A clone of the default branch that the agent never touches: the onboarding writes its files there.
  clone: string;
  jobDir: string;
  skillsDir: string;
  configDir: string | undefined;
  // Written into the config as skills of the planner and the builder.
  skills: string[];
  notes: string | undefined;
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
  writeFileSync(promptFile, onboardingPrompt({ repo: `${repo.owner}/${repo.name}`, hasDevcontainer, claudeCodeVersion: claudeCodeVersion(), notes: setup.notes }));
  setup.say(`==> onboarding agent (${AGENT.model}), up to ${AGENT_TIMEOUT_MINUTES} minutes`);
  await runAgent({
    harness: HARNESSES[AGENT.harness],
    credentials: setup.credentials,
    name: containerName("onboarding", repo.owner, repo.name),
    model: AGENT.model,
    effort: AGENT.effort,
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
  const dir = join(jobDir, repo.name);
  cpSync(setup.clone, dir, { recursive: true, verbatimSymlinks: true });
  const runDir = join(jobDir, "run");
  mkdirSync(runDir, { mode: 0o700 });
  const idLabel = `autopilot.job=${containerName("onboarding", repo.owner, repo.name)}`;
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

// The steps that `autopilot init` and the host share: the agent writes the dev container, the check
// commands and AGENTS.md, then the dev container and the checks run once on the default branch.
// The files land in the clone, uncommitted.
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
