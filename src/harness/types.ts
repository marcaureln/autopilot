import type { Agent } from "../core/config.ts";
import type { Mount } from "../core/docker.ts";

export type Credentials = { claudeToken: string; apiKeys: Record<string, string> };

export type Harness = {
  // docker/<name>/: the Dockerfile of the agent image, its managed config, and feature/ for the dev container.
  dir: string;
  // Hashed into the image tag: list every file the build reads.
  imageFiles: string[];
  // Must match the id in feature/devcontainer-feature.json.
  featureId: string;
  version(): string;
  // The agent image has it built in. A dev container gets it as a read-only mount.
  managedConfig: Mount;
  // The agent runs as root in both places. jobDir is a host folder of this job, for files to mount.
  mounts(skillsDir: string, configDir: string | undefined, jobDir: string): Mount[];
  missingCredential(credentials: Credentials): string | undefined;
  secretEnv(credentials: Credentials): Record<string, string>;
  // Not secret: docker run passes it as arguments, which the process list shows.
  env(workdir: string): Record<string, string>;
  // Env var prefixes that only the host may set. The repo's dev container can set env vars
  // (containerEnv, remoteEnv, ENV), so the agent starts without the ones that match.
  hostEnvPrefixes: string[];
  // "file": the command names PROMPT_FILE.
  prompt: "stdin" | "file";
  command(model: string, effort: Agent["effort"]): string[];
};
