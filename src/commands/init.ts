import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync, cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import packConfig from "../../stacks/node/autopilot.json" with { type: "json" };
import { claudeImage, runClaude } from "../harness/claude.ts";
import type { Audit } from "../core/audit.ts";
import { BASELINE_PATH, knownFailureLines, renderBaseline, type Baseline } from "../core/baseline.ts";
import { IMAGES, nodeInstallCommand, planChecks } from "../core/checks.ts";
import { CONFIG_PATH, parseConfig, type Config } from "../core/config.ts";
import { ensurePulled, runContainer } from "../core/docker.ts";
import { onboardingBody, onboardingPrompt, ownPull, parseOnboardingResult, RESULT_PATH, type PullListing, type Onboarding, type OnboardingResult, type ValidateResult } from "../core/onboarding.ts";
import type { Repo } from "../core/repo.ts";
import { refusedSecrets } from "../core/repo-secrets.ts";
import { readSecret } from "../core/secrets.ts";
import { detectNode, diskFiles, readiness, renderOnboarding, type NodeStack } from "../core/stack.ts";
import { LABELS } from "../core/state.ts";
import { readAgentFile, writeRepoFile } from "../core/workspace.ts";
import { forward, HOST_SECRETS } from "./client.ts";

export const BRANCH = "autopilot/onboarding";
const LIMITS = { memory: "6g", cpus: 2, pids: 1024 };
const AGENT_TIMEOUT_MINUTES = 20;
const CHECKS_TIMEOUT_MS = 10 * 60 * 1000;
const BASELINE_CHECKS = ["lint", "types"];

const noAudit: Audit = () => {};

export type InitOptions = { repo: Repo; host: string | undefined; agent: boolean };

function run(command: string, args: string[], cwd?: string, input?: string): string {
  return execFileSync(command, args, { cwd, input, encoding: "utf8", stdio: ["pipe", "pipe", "inherit"] }).trim();
}

function dockerRunning(): boolean {
  return spawnSync("docker", ["info"], { stdio: "ignore" }).status === 0;
}

async function adapt(clone: string, jobDir: string, repo: string, stack: NodeStack): Promise<{ kind: "ran"; result: OnboardingResult } | { kind: "skipped"; reason: string }> {
  if (!dockerRunning()) return { kind: "skipped", reason: "Docker is not running" };
  let claudeToken: string;
  try {
    claudeToken = readSecret(HOST_SECRETS.claude_token, "init: token for the onboarding agent", noAudit);
  } catch (error) {
    return { kind: "skipped", reason: `op could not read the Claude token: ${error instanceof Error ? error.message : String(error)}` };
  }
  const work = join(jobDir, "agent");
  cpSync(clone, work, { recursive: true, verbatimSymlinks: true });
  mkdirSync(join(work, ".autopilot"));
  appendFileSync(join(work, ".git", "info", "exclude"), "/.autopilot/\n");
  const skillsDir = join(jobDir, "skills");
  mkdirSync(skillsDir);
  const promptFile = join(jobDir, "prompt.md");
  writeFileSync(promptFile, onboardingPrompt({ repo, manager: stack.manager, commands: stack.commands }));
  const planner = parseConfig(JSON.stringify(packConfig), "the stack pack").agents.planner;
  console.log(`==> onboarding agent (${planner.model}), up to ${AGENT_TIMEOUT_MINUTES} minutes`);
  try {
    await claudeImage();
    await runClaude({
      name: `autopilot-init-${repo}`.toLowerCase().replace(/[^a-z0-9_.-]/g, "-"),
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
    const text = readAgentFile(work, RESULT_PATH, 64 * 1024);
    if (text === undefined) return { kind: "skipped", reason: `the agent wrote no ${RESULT_PATH}` };
    return { kind: "ran", result: parseOnboardingResult(text) };
  } catch (error) {
    return { kind: "skipped", reason: `the agent failed: ${error instanceof Error ? error.message : String(error)}` };
  }
}

async function validateChecks(clone: string, jobDir: string, repo: Repo, config: Config): Promise<{ results: ValidateResult[]; baseline: Baseline }> {
  const dir = join(jobDir, "validate");
  cpSync(clone, dir, { recursive: true, verbatimSymlinks: true });
  await ensurePulled(IMAGES.node);
  const deadline = Date.now() + CHECKS_TIMEOUT_MS;
  const container = (step: string, command: string, network: "none" | "bridge", secrets?: Record<string, string>) =>
    runContainer({
      name: `autopilot-init-${repo.owner}-${repo.name}-${step}`.toLowerCase().replace(/[^a-z0-9_.-]/g, "-"),
      image: IMAGES.node,
      command: ["sh", "-c", `cd /work && ${command}`],
      mounts: [{ source: dir, target: "/work", readonly: false }],
      network,
      secrets,
      limits: LIMITS,
      timeoutMs: deadline - Date.now(),
      audit: noAudit,
    });
  const install = nodeInstallCommand((file) => diskFiles(dir).read(file) !== undefined);
  if (install) {
    console.log(`==> install: ${install}`);
    const result = await container("install", install, "bridge");
    if (result.exit !== 0) return { results: [{ check: "install", outcome: "failed" }], baseline: {} };
  }
  const refused = refusedSecrets(repo, config.secrets);
  const own = Object.entries(config.secrets).filter(([name]) => !refused.includes(name));
  const results: ValidateResult[] = [];
  const baseline: Baseline = {};
  for (const plan of planChecks(config.verify.required, config.verify.commands)) {
    if (plan.kind !== "stack") continue;
    console.log(`==> ${plan.check}: ${plan.command}`);
    // Lint output can go into the committed baseline, so only the test check gets the values here.
    const secrets = plan.check === "test" ? Object.fromEntries(own.map(([name, reference]) => [name, readSecret(reference, "init: test check", noAudit)])) : undefined;
    const result = await container(plan.check, plan.command, "none", secrets);
    if (result.exit === 0) results.push({ check: plan.check, outcome: "passed" });
    else if (BASELINE_CHECKS.includes(plan.check) && !result.timedOut && !result.truncated && knownFailureLines(result.output).length > 0) {
      const lines = knownFailureLines(result.output);
      baseline[plan.check] = lines;
      results.push({ check: plan.check, outcome: "baseline", lines: lines.length });
    } else results.push({ check: plan.check, outcome: "failed" });
  }
  return { results, baseline };
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
  const jobDir = mkdtempSync(join(tmpdir(), "autopilot-init-"));
  try {
    const clone = join(jobDir, "repo");
    run("gh", ["repo", "clone", repo, clone, "--", "--depth", "1", "--quiet"]);
    const base = run("git", ["symbolic-ref", "--short", "HEAD"], clone);
    const files = diskFiles(clone);
    const detected = detectNode(files);
    if (!detected) throw new Error(`no stack pack matches ${repo}: the node pack needs a package.json at the root`);
    console.log(`==> stack: node (${detected.manager}), services: ${detected.services.join(", ") || "none"}`);

    const agent = options.agent ? await adapt(clone, jobDir, repo, detected) : { kind: "skipped" as const, reason: "--no-agent" };
    if (agent.kind === "skipped") console.log(`==> onboarding agent skipped: ${agent.reason}`);
    const stack = agent.kind === "ran" ? { ...detected, commands: { ...detected.commands, ...agent.result.commands } } : detected;
    const rendered = renderOnboarding(files, stack);
    if (agent.kind === "ran" && files.read("AGENTS.md") === undefined) rendered["AGENTS.md"] = `${agent.result.agents_md.trimEnd()}\n`;
    const config = parseConfig(rendered[CONFIG_PATH] ?? "", CONFIG_PATH);

    const validate = dockerRunning() ? { kind: "ran" as const, ...(await validateChecks(clone, jobDir, options.repo, config)) } : { kind: "skipped" as const, reason: "Docker is not running" };
    if (validate.kind === "ran" && Object.keys(validate.baseline).length > 0) rendered[BASELINE_PATH] = renderBaseline(validate.baseline);

    for (const [path, text] of Object.entries(rendered)) writeRepoFile(clone, path, text);

    ensureLabels(repo);
    let host: Onboarding["host"] = { kind: "none" };
    if (options.host) {
      console.log("==> allow the repo on the host");
      if ((await forward(options.host, ["allow", repo])) !== 0) throw new Error("the host could not allow the repo");
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
      manager: stack.manager,
      generated: Object.keys(rendered),
      agent: agent.kind === "ran" ? { kind: "ran", notes: agent.result.notes } : agent,
      validate: validate.kind === "ran" ? { kind: "ran", results: validate.results } : validate,
      host,
      readiness: readiness(diskFiles(clone), paths),
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
