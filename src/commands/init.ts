import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { claudeCodeVersion, runClaude } from "../harness/claude.ts";
import type { Audit } from "../core/audit.ts";
import { BASELINE_PATH, knownFailureLines, renderBaseline, type Baseline } from "../core/baseline.ts";
import { planChecks } from "../core/checks.ts";
import { CONFIG_PATH, parseConfig, type Config } from "../core/config.ts";
import { cliDevcontainer } from "../core/devcontainer-cli.ts";
import { containerName } from "../core/docker.ts";
import { checkCommand, EnvironmentRefused, RUN_DIR, SECRETS_NAME, shellEnvFile, startEnvironment, stopEnvironment } from "../core/environment.ts";
import { parseSource } from "../core/host.ts";
import {
  devcontainerFiles,
  diskFiles,
  onboardingBody,
  onboardingPrompt,
  ownPull,
  parseOnboardingResult,
  readiness,
  renderConfig,
  RESULT_PATH,
  type Onboarding,
  type OnboardingResult,
  type PullListing,
  type ValidateResult,
} from "../core/onboarding.ts";
import type { Repo } from "../core/repo.ts";
import { refusedSecrets } from "../core/repo-secrets.ts";
import { readSecret } from "../core/secrets.ts";
import { LABELS } from "../core/state.ts";
import { readAgentFile, writeRepoFile } from "../core/workspace.ts";
import { forward, HOST_SECRETS } from "./client.ts";

export const BRANCH = "autopilot/onboarding";
const LIMITS = { memory: "6g", cpus: 2, pids: 1024 };
const AGENT_TIMEOUT_MINUTES = 20;
const CHECKS_TIMEOUT_MS = 20 * 60 * 1000;
const BASELINE_CHECKS = ["lint", "types"];

const noAudit: Audit = () => {};

export type InitOptions = { repo: Repo; host: string | undefined; skills: string[]; notesFile: string | undefined };

function run(command: string, args: string[], cwd?: string, input?: string): string {
  return execFileSync(command, args, { cwd, input, encoding: "utf8", stdio: ["pipe", "pipe", "inherit"] }).trim();
}

function dockerRunning(): boolean {
  return spawnSync("docker", ["info"], { stdio: "ignore" }).status === 0;
}

// init runs on the client, with the user's gh login: it has no App token to fetch a skill the way the host does.
function fetchSkills(entries: string[], jobDir: string): string {
  const skillsDir = join(jobDir, "skills");
  mkdirSync(skillsDir);
  for (const [index, entry] of entries.entries()) {
    const source = parseSource(entry, "--skill");
    let dir: string;
    if (source.kind === "path") {
      if (!existsSync(source.path)) {
        console.log(`==> --skill ${entry} is not on this machine: the onboarding agent runs without it, the host reads it`);
        continue;
      }
      dir = source.path;
    } else {
      const dest = join(jobDir, "sources", String(index));
      run("gh", ["repo", "clone", `${source.owner}/${source.repo}`, dest, "--", "--depth", "1", "--quiet", ...(source.ref ? ["--branch", source.ref] : [])]);
      dir = join(dest, source.subdir ?? "");
    }
    if (!lstatSync(join(dir, "SKILL.md"), { throwIfNoEntry: false })?.isFile()) throw new Error(`--skill ${entry} has no SKILL.md`);
    cpSync(dir, join(skillsDir, basename(dir)), { recursive: true, verbatimSymlinks: true });
  }
  return skillsDir;
}

type AgentInput = { clone: string; jobDir: string; repo: string; hasDevcontainer: boolean; notes: string | undefined; skills: string[]; claudeToken: string };

async function onboardingAgent({ clone, jobDir, repo, hasDevcontainer, notes, skills, claudeToken }: AgentInput): Promise<OnboardingResult> {
  const work = join(jobDir, "agent");
  cpSync(clone, work, { recursive: true, verbatimSymlinks: true });
  mkdirSync(join(work, ".autopilot"));
  appendFileSync(join(work, ".git", "info", "exclude"), "/.autopilot/\n");
  const skillsDir = fetchSkills(skills, jobDir);
  const promptFile = join(jobDir, "prompt.md");
  writeFileSync(promptFile, onboardingPrompt({ repo, hasDevcontainer, claudeCodeVersion: claudeCodeVersion(), notes }));
  const planner = parseConfig('{ "version": 1 }', "the defaults").agents.planner;
  console.log(`==> onboarding agent (${planner.model}), up to ${AGENT_TIMEOUT_MINUTES} minutes`);
  await runClaude({
    name: containerName("init", repo),
    model: planner.model,
    effort: planner.effort,
    promptFile,
    skillsDir,
    workdir: work,
    limits: LIMITS,
    timeoutMinutes: AGENT_TIMEOUT_MINUTES,
    claudeToken,
    audit: noAudit,
  });
  const text = readAgentFile(work, RESULT_PATH, 256 * 1024);
  if (text === undefined) throw new Error(`the onboarding agent wrote no ${RESULT_PATH}`);
  return parseOnboardingResult(text);
}

type Validated = { validate: Onboarding["validate"]; baseline: Baseline };

// The same steps as the checks of a pull request: up (with the install), no network, each command once.
async function validateEnvironment(clone: string, jobDir: string, repo: Repo, config: Config): Promise<Validated> {
  const dir = join(jobDir, repo.name);
  cpSync(clone, dir, { recursive: true, verbatimSymlinks: true });
  const runDir = join(jobDir, "run");
  mkdirSync(runDir, { mode: 0o700 });
  const idLabel = `autopilot.job=${containerName("init", repo.owner, repo.name)}`;
  const deadline = Date.now() + CHECKS_TIMEOUT_MS;
  console.log("==> devcontainer up (build, then the install)");
  try {
    const up = await startEnvironment({
      devcontainer: cliDevcontainer,
      workspace: dir,
      idLabel,
      limits: LIMITS,
      mounts: [{ source: runDir, target: RUN_DIR, readonly: true }],
      claudeCodeVersion: undefined,
      timeoutMs: deadline - Date.now(),
      audit: noAudit,
    });
    if (up.kind === "failed") {
      console.log(up.result.output.split("\n").slice(-20).join("\n"));
      return { validate: { kind: "ran", results: [{ check: "install", outcome: "failed" }] }, baseline: {} };
    }
    await cliDevcontainer.cutNetwork(up.containerId);
    const results: ValidateResult[] = [{ check: "install", outcome: "passed" }];
    const baseline: Baseline = {};
    const refused = refusedSecrets(repo, config.secrets);
    const own = Object.entries(config.secrets).filter(([name]) => !refused.includes(name));
    // Lint output can go into the committed baseline, so only the test check gets the secrets, and it runs last.
    const plans = planChecks(config.verify.required, config.verify.commands).flatMap((plan) => (plan.kind === "command" ? [plan] : []));
    for (const plan of plans.toSorted((a, b) => Number(a.check === "test") - Number(b.check === "test"))) {
      console.log(`==> ${plan.check}: ${plan.command}`);
      const withSecrets = plan.check === "test" && own.length > 0;
      if (withSecrets) {
        const secrets = Object.fromEntries(own.map(([name, reference]) => [name, readSecret(reference, "init: test check", noAudit)]));
        writeFileSync(join(runDir, SECRETS_NAME), shellEnvFile(secrets), { mode: 0o600, flag: "wx" });
      }
      const result = await cliDevcontainer.exec(up.containerId, checkCommand(plan.command, up.workspaceFolder, withSecrets), { timeoutMs: deadline - Date.now() });
      if (result.exit === 0 && !result.timedOut) results.push({ check: plan.check, outcome: "passed" });
      else if (BASELINE_CHECKS.includes(plan.check) && !result.timedOut && !result.truncated && knownFailureLines(result.output).length > 0) {
        const lines = knownFailureLines(result.output);
        baseline[plan.check] = lines;
        results.push({ check: plan.check, outcome: "baseline", lines: lines.length });
      } else results.push({ check: plan.check, outcome: "failed" });
    }
    return { validate: { kind: "ran", results }, baseline };
  } catch (error) {
    if (!(error instanceof EnvironmentRefused)) throw error;
    console.log(error.message);
    return { validate: { kind: "refused", problems: error.problems }, baseline: {} };
  } finally {
    await stopEnvironment(cliDevcontainer, idLabel, noAudit);
  }
}

function ensureLabels(repo: string): void {
  const existing = new Set(run("gh", ["label", "list", "--repo", repo, "--limit", "500", "--json", "name", "--jq", ".[].name"]).split("\n"));
  for (const label of LABELS.filter((label) => !existing.has(label.name))) {
    run("gh", ["label", "create", label.name, "--repo", repo, "--color", label.color, "--description", label.description]);
    console.log(`==> label ${label.name} created`);
  }
}

export async function init(options: InitOptions): Promise<void> {
  const repo = `${options.repo.owner}/${options.repo.name}`;
  for (const skill of options.skills) parseSource(skill, "--skill");
  const notes = options.notesFile === undefined ? undefined : readFileSync(options.notesFile, "utf8");
  if (!dockerRunning()) throw new Error("Docker is not running: init runs the onboarding agent and the checks in containers");
  const claudeToken = readSecret(HOST_SECRETS.claude_token, "init: token for the onboarding agent", noAudit);
  const jobDir = mkdtempSync(join(tmpdir(), "autopilot-init-"));
  try {
    const clone = join(jobDir, "repo");
    run("gh", ["repo", "clone", repo, clone, "--", "--depth", "1", "--quiet"]);
    const base = run("git", ["symbolic-ref", "--short", "HEAD"], clone);
    const files = diskFiles(clone);
    const hasDevcontainer = existsSync(join(clone, ".devcontainer")) || existsSync(join(clone, ".devcontainer.json"));
    console.log(hasDevcontainer ? "==> the repo has a dev container: init keeps it" : "==> the repo has no dev container: the onboarding agent writes one");

    const result = await onboardingAgent({ clone, jobDir, repo, hasDevcontainer, notes, skills: options.skills, claudeToken });
    const rendered: Record<string, string> = { ...devcontainerFiles(result, hasDevcontainer), [CONFIG_PATH]: renderConfig(files.read(CONFIG_PATH), result.commands, options.skills) };
    if (files.read("AGENTS.md") === undefined) rendered["AGENTS.md"] = `${result.agents_md.trimEnd()}\n`;
    const config = parseConfig(rendered[CONFIG_PATH] ?? "", CONFIG_PATH);
    for (const [path, text] of Object.entries(rendered)) writeRepoFile(clone, path, text);

    const { validate, baseline } = await validateEnvironment(clone, jobDir, options.repo, config);
    if (Object.keys(baseline).length > 0) {
      rendered[BASELINE_PATH] = renderBaseline(baseline);
      writeRepoFile(clone, BASELINE_PATH, rendered[BASELINE_PATH]);
    }

    ensureLabels(repo);
    let host: Onboarding["host"] = { kind: "none" };
    if (options.host) {
      console.log("==> allow the repo on the host");
      if ((await forward(options.host, ["watch", repo])) !== 0) throw new Error("the host could not watch the repo");
      host = { kind: "allowed" };
    }

    const paths = run("git", ["ls-files", "--cached", "--others", "--exclude-standard"], clone).split("\n");
    run("git", ["checkout", "--quiet", "-b", BRANCH], clone);
    run("git", ["add", "--", ...Object.keys(rendered)], clone);
    if (run("git", ["status", "--porcelain"], clone) === "") return console.log(`${repo} is already onboarded: nothing to change`);
    run("git", ["commit", "--quiet", "-m", "chore: onboard the repo to autopilot"], clone);
    run("git", ["push", "--quiet", "--force", "origin", `HEAD:refs/heads/${BRANCH}`], clone);

    const body = onboardingBody({
      repo,
      merge: config.merge,
      generated: Object.keys(rendered),
      notes: result.notes,
      environment: { ...result.environment, existing: hasDevcontainer },
      validate,
      host,
      readiness: readiness(diskFiles(clone), paths, config.verify.commands),
    });
    const listing: PullListing[] = JSON.parse(run("gh", ["pr", "list", "--repo", repo, "--head", BRANCH, "--state", "open", "--json", "url,isCrossRepository,headRepositoryOwner,headRepository"]));
    const open = ownPull(listing, options.repo);
    if (open) {
      run("gh", ["pr", "edit", open, "--body-file", "-"], undefined, body);
      console.log(`updated ${open}`);
    } else {
      console.log(run("gh", ["pr", "create", "--repo", repo, "--base", base, "--head", BRANCH, "--title", "chore: onboard the repo to autopilot", "--body-file", "-"], undefined, body));
    }
  } finally {
    rmSync(jobDir, { recursive: true, force: true });
  }
}
