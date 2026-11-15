import { cpSync, existsSync, lstatSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { basename, join } from "node:path";
import type { GitHub } from "./github.ts";
import type { Host } from "./host.ts";
import { fetchSource } from "./workspace.ts";

// People with write access to the repo write its config, not the host owner. A host path there must
// point inside this directory, so a repo cannot copy host files into the agent.
export const HOST_SKILLS_DIR = "/etc/autopilot/skills";

export type AgentSetup = { skillsDir: string; claudeConfigDir: string | undefined };

function insideHostSkills(path: string): boolean {
  const real = realpathSync(path);
  return real.startsWith(`${HOST_SKILLS_DIR}/`);
}

export async function prepareAgent(host: Host, roleSkills: string[], github: GitHub, jobDir: string): Promise<AgentSetup> {
  const skillsDir = join(jobDir, "skills");
  mkdirSync(skillsDir);
  const claudeConfigDir = host.claude?.config ? await fetchSource(host.claude.config, github, join(jobDir, "claude"), "claude.config") : undefined;
  if (claudeConfigDir && existsSync(join(claudeConfigDir, "skills"))) cpSync(join(claudeConfigDir, "skills"), skillsDir, { recursive: true });

  for (const [index, entry] of roleSkills.entries()) {
    const dir = await fetchSource(entry, github, join(jobDir, "sources", String(index)), "skills");
    if (entry.startsWith("/") && !insideHostSkills(dir)) throw new Error(`skills: ${entry} is outside ${HOST_SKILLS_DIR}`);
    if (!lstatSync(join(dir, "SKILL.md"), { throwIfNoEntry: false })?.isFile()) throw new Error(`skills: ${entry} has no SKILL.md`);
    const target = join(skillsDir, basename(dir));
    rmSync(target, { recursive: true, force: true });
    cpSync(dir, target, { recursive: true });
  }
  return { skillsDir, claudeConfigDir };
}
