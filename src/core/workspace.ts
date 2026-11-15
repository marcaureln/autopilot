import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import type { GitHub } from "./github.ts";
import { parseClaudeConfigSource } from "./host.ts";
import type { Repo } from "./repo.ts";

const run = promisify(execFile);

// The token goes in through git's environment config, so it is not in the process list
// and not written to .git/config.
export async function shallowClone(repo: Repo, token: string, dest: string, ref?: string): Promise<void> {
  const header = `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`;
  const branch = ref ? ["--branch", ref] : [];
  await run("git", ["clone", "--quiet", "--depth", "1", "--single-branch", ...branch, `https://github.com/${repo.owner}/${repo.name}.git`, dest], {
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: "0",
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
      GIT_CONFIG_VALUE_0: header,
    },
  });
}

export async function fetchClaudeConfig(value: string, github: GitHub, dest: string): Promise<string> {
  const source = parseClaudeConfigSource(value);
  if (source.kind === "path") {
    if (!existsSync(source.path)) throw new Error(`claude.config ${source.path} does not exist on the host`);
    return source.path;
  }
  const repo = { owner: source.owner, name: source.repo };
  const installationId = await github.findInstallation({ owner: repo.owner, repo: repo.name });
  if (installationId === undefined) throw new Error(`claude.config: the App is not installed on ${repo.owner}/${repo.name}`);
  await shallowClone(repo, await github.repo(installationId, repo).token(), dest, source.ref);
  const dir = join(dest, source.subdir ?? "");
  if (!existsSync(dir)) throw new Error(`claude.config: ${source.subdir} is not in ${repo.owner}/${repo.name}`);
  return dir;
}
