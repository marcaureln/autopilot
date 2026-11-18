import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
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
  // OpenCode reads ~/.claude/skills. The global AGENTS.md comes before ~/.claude/CLAUDE.md, which the
  // image could add. The global config folder is a read-only folder of the host, so the image cannot
  // put a config, a plugin or a tool there.
  mounts(skillsDir, configDir, jobDir) {
    const globalDir = join(jobDir, "opencode");
    mkdirSync(globalDir);
    const instructions = configDir && join(configDir, "CLAUDE.md");
    if (instructions && existsSync(instructions)) copyFileSync(instructions, join(globalDir, "AGENTS.md"));
    return [
      { source: skillsDir, target: "/root/.claude/skills", readonly: true },
      { source: globalDir, target: "/root/.config/opencode", readonly: true },
    ];
  },
  missingCredential: ({ apiKeys }) => (Object.keys(apiKeys).length === 0 ? "OpenCode needs a provider API key: add it to secrets.api_keys in host.json" : undefined),
  secretEnv: ({ apiKeys }) => apiKeys,
  // A repo's opencode.json or .opencode/ could send the API key to another server or load a plugin.
  // Without project config OpenCode also skips the repo's AGENTS.md, so it is added back.
  // HOME and the XDG_ variables decide where OpenCode finds its global config.
  env: (workdir) => ({ HOME: "/root", OPENCODE_DISABLE_PROJECT_CONFIG: "1", OPENCODE_CONFIG_CONTENT: JSON.stringify({ instructions: [`${workdir}/AGENTS.md`] }) }),
  // OPENCODE_CONFIG, OPENCODE_CONFIG_DIR, OPENCODE_MODELS_URL and others load config, a model
  // catalog or native code from a path or URL.
  hostEnvPrefixes: ["OPENCODE_", "XDG_"],
  prompt: "file",
  // --standalone: a private server reads the API keys from this environment, and the shared
  // background service does not. The effort is the model variant: a model without it fails the run.
  command: (model, effort) => ["opencode", "run", "--standalone", "--model", effort ? `${model}#${effort}` : model, "--auto", "--format", "json", "--file", PROMPT_FILE, "Do the task in the attached file."],
};
