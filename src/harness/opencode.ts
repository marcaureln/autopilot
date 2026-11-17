import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PROMPT_FILE } from "../core/environment.ts";
import type { Harness } from "./harness.ts";

const DIR = new URL("../../docker/opencode/", import.meta.url).pathname;

export const opencode: Harness = {
  dir: DIR,
  imageFiles: ["Dockerfile", "opencode.json", "feature/install.sh"],
  featureId: "autopilot-opencode",
  version() {
    const match = /^ARG OPENCODE_VERSION=(\d+\.\d+\.\d+)$/m.exec(readFileSync(join(DIR, "Dockerfile"), "utf8"));
    if (!match?.[1]) throw new Error("docker/opencode/Dockerfile pins no OpenCode version");
    return match[1];
  },
  managedConfig: { source: join(DIR, "opencode.json"), target: "/etc/opencode/opencode.json", readonly: true },
  // OpenCode reads ~/.claude/skills, and AGENTS.md but not CLAUDE.md.
  mounts(skillsDir, configDir) {
    const instructions = configDir && join(configDir, "CLAUDE.md");
    return [
      { source: skillsDir, target: "/root/.claude/skills", readonly: true },
      ...(instructions && existsSync(instructions) ? [{ source: instructions, target: "/root/.config/opencode/AGENTS.md", readonly: true }] : []),
    ];
  },
  secretEnv({ apiKeys }) {
    if (Object.keys(apiKeys).length === 0) throw new Error("OpenCode needs a provider API key: add it to secrets.api_keys in host.json");
    return apiKeys;
  },
  env: {},
  prompt: "file",
  // --standalone: only a private server gets the API keys from this environment. The effort is the
  // model's variant, and a model without that variant fails the run.
  command: (model, effort) => ["opencode", "run", "--standalone", "--model", effort ? `${model}#${effort}` : model, "--auto", "--format", "json", "--file", PROMPT_FILE, "Do the task in the attached file."],
};
