import { cpSync, existsSync, lstatSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { basename, join } from "node:path";
import { parseAllowEntry } from "./allow.ts";
import type { GitHub } from "./github.ts";
import { parseSource, type Host } from "./host.ts";
import { fetchSource } from "./workspace.ts";

// People with write access to the repo write its config, not the host owner. A host path there must
// point inside this directory, so a repo cannot copy host files into the agent.
export const HOST_SKILLS_DIR = "/etc/autopilot/skills";

export type AgentSetup = { skillsDir: string; claudeConfigDir: string | undefined };

function within(path: string, root: string): boolean {
  const real = realpathSync(path);
  const realRoot = realpathSync(root);
  return real === realRoot || real.startsWith(`${realRoot}/`);
}

// A repo config could otherwise copy a skill from another account that installed the App.
function isAllowedRepo(owner: string, repo: string, allow: string[]): boolean {
  return allow.map(parseAllowEntry).some((entry) => entry.owner === owner && (entry.repo === undefined || entry.repo === repo));
}

export async function prepareAgent(host: Host, roleSkills: string[], github: GitHub, jobDir: string): Promise<AgentSetup> {
  const skillsDir = join(jobDir, "skills");
  mkdirSync(skillsDir);
  const claudeConfigDir = host.claude?.config ? await fetchSource(host.claude.config, github, join(jobDir, "claude"), "claude.config") : undefined;
  if (claudeConfigDir && existsSync(join(claudeConfigDir, "skills"))) cpSync(join(claudeConfigDir, "skills"), skillsDir, { recursive: true, verbatimSymlinks: true });

  for (const [index, entry] of roleSkills.entries()) {
    const source = parseSource(entry, "skills");
    if (source.kind === "github" && !isAllowedRepo(source.owner, source.repo, host.allow)) throw new Error(`skills: ${source.owner}/${source.repo} is not in the host allowlist`);
    const dest = join(jobDir, "sources", String(index));
    const dir = await fetchSource(entry, github, dest, "skills");
    // A symlink in the clone or on the host path must not lead out of it.
    const root = source.kind === "path" ? HOST_SKILLS_DIR : dest;
    if (!existsSync(root) || !within(dir, root)) throw new Error(`skills: ${entry} leads outside ${source.kind === "path" ? HOST_SKILLS_DIR : "its repository"}`);
    if (!lstatSync(join(dir, "SKILL.md"), { throwIfNoEntry: false })?.isFile()) throw new Error(`skills: ${entry} has no SKILL.md`);
    const target = join(skillsDir, basename(dir));
    rmSync(target, { recursive: true, force: true });
    cpSync(dir, target, { recursive: true, verbatimSymlinks: true });
  }
  return { skillsDir, claudeConfigDir };
}
