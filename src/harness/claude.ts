import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import managedSettings from "../../docker/claude/managed-settings.json" with { type: "json" };
import type { Harness } from "./types.ts";

const DIR = new URL("../../docker/claude/", import.meta.url).pathname;

const SETTINGS = JSON.stringify({ attribution: managedSettings.attribution });

// Entries of the personal config that Claude Code reads. Each one is mounted on its own, so the rest
// of ~/.claude (sessions, caches) stays writable inside the container.
const PERSONAL_ENTRIES = ["CLAUDE.md", "settings.json", "agents", "commands"];

// The Claude Code version of the agent image, which the dev containers that init writes pin too.
export function claudeCodeVersion(): string {
  const match = /@anthropic-ai\/claude-code@(\d+\.\d+\.\d+)/.exec(readFileSync(join(DIR, "Dockerfile"), "utf8"));
  if (!match?.[1]) throw new Error("docker/claude/Dockerfile pins no Claude Code version");
  return match[1];
}

export const claude: Harness = {
  dir: DIR,
  imageFiles: ["Dockerfile", "managed-settings.json"],
  featureId: "autopilot-claude-code",
  version: claudeCodeVersion,
  managedConfig: { source: join(DIR, "managed-settings.json"), target: "/etc/claude-code/managed-settings.json", readonly: true },
  mounts(skillsDir, configDir) {
    const personal = configDir
      ? PERSONAL_ENTRIES.filter((entry) => existsSync(join(configDir, entry))).map((entry) => ({ source: join(configDir, entry), target: `/root/.claude/${entry}`, readonly: true }))
      : [];
    return [{ source: skillsDir, target: "/root/.claude/skills", readonly: true }, ...personal];
  },
  // The service does not start without the token.
  missingCredential: () => undefined,
  secretEnv: ({ claudeToken }) => ({ CLAUDE_CODE_OAUTH_TOKEN: claudeToken }),
  // Claude Code refuses to bypass permissions as root unless it is told it runs in a sandbox.
  env: () => ({ IS_SANDBOX: "1" }),
  // ANTHROPIC_BASE_URL, CLAUDE_CONFIG_DIR and others send the token to another server or load
  // another config. The managed settings also pin ANTHROPIC_BASE_URL, over a repo's .claude/settings.json.
  hostEnvPrefixes: ["ANTHROPIC_", "CLAUDE_"],
  prompt: "stdin",
  command: (model, effort) => ["claude", "--print", "--model", model, ...(effort ? ["--effort", effort] : []), "--permission-mode", "bypassPermissions", "--settings", SETTINGS],
};
