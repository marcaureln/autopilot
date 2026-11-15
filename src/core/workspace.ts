import { execFile } from "node:child_process";
import { closeSync, constants, existsSync, fstatSync, lstatSync, openSync, readFileSync } from "node:fs";
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

// The agent controls the workdir, so a result file could be a symlink to a host file or a FIFO
// that blocks the read.
export function readAgentFile(workdir: string, path: string, maxBytes: number): string | undefined {
  const parts = path.split("/");
  let current = workdir;
  for (const [index, part] of parts.entries()) {
    current = join(current, part);
    const stat = lstatSync(current, { throwIfNoEntry: false });
    if (!stat) return undefined;
    const isLast = index === parts.length - 1;
    if (!isLast && !stat.isDirectory()) throw new Error(`${path}: ${part} is not a directory`);
    if (isLast && !stat.isFile()) throw new Error(`${path} is not a regular file`);
  }
  const fd = openSync(current, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw new Error(`${path} is not a regular file`);
    if (stat.size > maxBytes) throw new Error(`${path} is larger than ${maxBytes} bytes`);
    return readFileSync(fd, "utf8");
  } finally {
    closeSync(fd);
  }
}
