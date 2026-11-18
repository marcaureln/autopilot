import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { readOptionFile } from "../core/option-file.ts";
import { cliDevcontainer } from "../core/devcontainer-cli.ts";
import { parseSource } from "../core/host.ts";
import { ONBOARDING_COMMIT, prepareOnboarding } from "../core/onboarder.ts";
import { ONBOARDING_BRANCH, onboardingBody, ownPull, type Onboarding, type PullListing } from "../core/onboarding.ts";
import type { Repo } from "../core/repo.ts";
import { LABELS } from "../core/state.ts";
import { forward } from "./client.ts";

const LIMITS = { memory: "6g", cpus: 2, pids: 1024 };

export type InitOptions = { repo: Repo; host: string | undefined; skills: string[]; notesFile: string | undefined; claudeToken: () => Promise<string> };

function run(command: string, args: string[], cwd?: string, input?: string): string {
  try {
    return execFileSync(command, args, { cwd, input, encoding: "utf8", stdio: ["pipe", "pipe", "inherit"] }).trim();
  } catch (error) {
    const exit = error instanceof Error && "status" in error && typeof error.status === "number" ? ` (exit ${error.status})` : "";
    throw new Error(`${command} failed${exit}. See the message above.`, { cause: error });
  }
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
  const notes = options.notesFile === undefined ? undefined : readOptionFile("--notes", options.notesFile);
  if (!dockerRunning()) throw new Error("Docker is not running: init runs the onboarding agent and the checks in containers");
  const claudeToken = await options.claudeToken();
  const jobDir = mkdtempSync(join(tmpdir(), "autopilot-init-"));
  try {
    const clone = join(jobDir, "repo");
    run("gh", ["repo", "clone", repo, clone, "--", "--depth", "1", "--quiet"]);
    const base = run("git", ["symbolic-ref", "--short", "HEAD"], clone);
    const onboarding = await prepareOnboarding({
      repo: options.repo,
      jobName: "init",
      clone,
      jobDir,
      skillsDir: fetchSkills(options.skills, jobDir),
      configDir: undefined,
      skills: options.skills,
      notes,
      request: undefined,
      credentials: { claudeToken, apiKeys: {} },
      devcontainer: cliDevcontainer,
      limits: LIMITS,
      audit: () => undefined,
      say: (line) => console.log(line),
    });

    ensureLabels(repo);
    let host: Onboarding["host"] = { kind: "none" };
    if (options.host) {
      console.log("==> watch the repo on the host");
      if ((await forward(options.host, ["watch", repo])) !== 0) throw new Error("the host could not watch the repo");
      host = { kind: "watched" };
    }

    run("git", ["checkout", "--quiet", "-b", ONBOARDING_BRANCH], clone);
    run("git", ["add", "--", ...onboarding.generated], clone);
    if (run("git", ["status", "--porcelain"], clone) === "") return console.log(`${repo} is already onboarded: nothing to change`);
    run("git", ["commit", "--quiet", "-m", ONBOARDING_COMMIT], clone);
    run("git", ["push", "--quiet", "--force", "origin", `HEAD:refs/heads/${ONBOARDING_BRANCH}`], clone);

    const body = onboardingBody({ ...onboarding, host });
    const listing: PullListing[] = JSON.parse(run("gh", ["pr", "list", "--repo", repo, "--head", ONBOARDING_BRANCH, "--state", "open", "--json", "url,isCrossRepository,headRepositoryOwner,headRepository"]));
    const open = ownPull(listing, options.repo);
    if (open) {
      run("gh", ["pr", "edit", open, "--body-file", "-"], undefined, body);
      console.log(`updated ${open}`);
    } else {
      console.log(run("gh", ["pr", "create", "--repo", repo, "--base", base, "--head", ONBOARDING_BRANCH, "--title", ONBOARDING_COMMIT, "--body-file", "-"], undefined, body));
    }
  } finally {
    rmSync(jobDir, { recursive: true, force: true });
  }
}
