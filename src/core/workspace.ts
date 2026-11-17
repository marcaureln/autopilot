import { execFile } from "node:child_process";
import { closeSync, constants, copyFileSync, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync, writeSync } from "node:fs";
import { join, posix, sep } from "node:path";
import { promisify } from "node:util";
import type { GitHub } from "./github.ts";
import { parseSource } from "./host.ts";
import type { Repo } from "./repo.ts";

const run = promisify(execFile);

export function repoUrl(repo: Repo): string {
  return `https://github.com/${repo.owner}/${repo.name}.git`;
}

// The token goes in through git's environment config, so it is not in the process list
// and not written to .git/config.
export function gitAuthEnv(token: string): NodeJS.ProcessEnv {
  const header = `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`;
  return {
    ...process.env,
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
    GIT_CONFIG_VALUE_0: header,
  };
}

// A repo's .lfsconfig can name another LFS server. Git config from the environment wins over it, so
// the LFS objects and the token go only to the repo's own LFS.
// The endpoint follows git-lfs's own rule: an https remote serves LFS at <url>/info/lfs, a file:// remote at its path.
function lfsEnv(url: string, token: string): NodeJS.ProcessEnv {
  const lfs = url.startsWith("file://") ? url : `${url}/info/lfs`;
  return { ...gitAuthEnv(token), GIT_CONFIG_COUNT: "3", GIT_CONFIG_KEY_1: "lfs.url", GIT_CONFIG_VALUE_1: lfs, GIT_CONFIG_KEY_2: "lfs.pushurl", GIT_CONFIG_VALUE_2: lfs };
}

export async function shallowClone(repo: Repo, token: string, dest: string, ref?: string, depth = 1): Promise<void> {
  const branch = ref ? ["--branch", ref] : [];
  // The LFS objects come from `fetchLfsObjects`, so a filter that is set up on the host cannot make the clone fail.
  await run("git", ["clone", "--quiet", "--depth", String(depth), "--single-branch", ...branch, repoUrl(repo), dest], { env: { ...gitAuthEnv(token), GIT_LFS_SKIP_SMUDGE: "1" } });
  await fetchLfsObjects(dest, repoUrl(repo), token);
}

// `git grep` exits with 1 when nothing matches.
async function usesLfs(dir: string, rev: string): Promise<boolean> {
  try {
    await run("git", ["grep", "--quiet", "filter=lfs", rev, "--", ".gitattributes", ":(glob)**/.gitattributes"], { cwd: dir });
    return true;
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === 1) return false;
    throw error;
  }
}

async function requireGitLfs(): Promise<void> {
  await run("git", ["lfs", "version"]).catch(() => {
    throw new Error("this repo uses Git LFS and the host has no git-lfs: install the git-lfs package");
  });
}

// The checkout gets the real files. Its `.git/config` gets the LFS filters, so a copy of it turns the
// files that the builder adds into LFS objects.
async function fetchLfsObjects(dir: string, url: string, token: string): Promise<void> {
  if (!(await usesLfs(dir, "HEAD"))) return;
  await requireGitLfs();
  await run("git", ["lfs", "install", "--local"], { cwd: dir });
  await run("git", ["lfs", "pull"], { cwd: dir, env: lfsEnv(url, token) });
}

const LFS_OBJECT = /^([0-9a-f]{2})\/([0-9a-f]{2})\/(\1\2[0-9a-f]{60})$/;

// The agent adds LFS objects to its own copy, and the bundle carries only the pointers. The agent
// controls that copy, so the folder must be a real folder inside it, and only regular files named as
// LFS objects come over. The server checks the hash of each object it receives. Returns a problem, if any.
export function importLfsObjects(agentCheckout: string, dir: string, maxBytes: number): string | undefined {
  const from = join(agentCheckout, ".git", "lfs", "objects");
  if (!existsSync(from)) return undefined;
  if (realpathSync(from) !== join(realpathSync(agentCheckout), ".git", "lfs", "objects")) return "the LFS objects folder of the checkout is a symlink";
  let total = 0;
  for (const entry of readdirSync(from, { recursive: true, encoding: "utf8" })) {
    const path = join(from, entry);
    const stat = lstatSync(path);
    if (stat.isDirectory()) continue;
    if (!stat.isFile() || !LFS_OBJECT.test(entry.split(sep).join("/"))) return `${entry} in the LFS objects folder is not an LFS object`;
    total += stat.size;
    if (total > maxBytes) return `the new LFS objects are larger than ${maxBytes / 1024 / 1024} MB`;
    const target = join(dir, ".git", "lfs", "objects", entry);
    if (existsSync(target)) continue;
    mkdirSync(join(target, ".."), { recursive: true });
    copyFileSync(path, target);
  }
  return undefined;
}

// The objects go first, so the branch never points at an LFS object that the server lacks. `--no-verify`
// skips the LFS pre-push hook, which would push the objects a second time.
export async function pushBranch(dir: string, url: string, token: string, lease: string, head: string, branch: string): Promise<void> {
  const env = lfsEnv(url, token);
  if (await usesLfs(dir, head)) {
    await requireGitLfs();
    await run("git", ["lfs", "push", url, head], { cwd: dir, env });
  }
  await run("git", ["push", "--quiet", "--no-verify", lease, url, `${head}:refs/heads/${branch}`], { cwd: dir, env });
}

export async function fetchSource(value: string, github: GitHub, dest: string, field: string): Promise<string> {
  const source = parseSource(value, field);
  if (source.kind === "path") {
    if (!existsSync(source.path)) throw new Error(`${field} ${source.path} does not exist on the host`);
    return source.path;
  }
  const repo = { owner: source.owner, name: source.repo };
  const installationId = await github.findInstallation({ owner: repo.owner, repo: repo.name });
  if (installationId === undefined) throw new Error(`${field}: the App is not installed on ${repo.owner}/${repo.name}`);
  await shallowClone(repo, await github.repo(installationId, repo).token(), dest, source.ref);
  const dir = join(dest, source.subdir ?? "");
  if (!existsSync(dir)) throw new Error(`${field}: ${source.subdir} is not in ${repo.owner}/${repo.name}`);
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

export function writeRepoFile(root: string, path: string, text: string): void {
  const parts = path.split("/");
  if (path.startsWith("/") || posix.normalize(path) !== path || parts.some((part) => part === "" || part === "." || part === "..")) {
    throw new Error(`${path} is not a plain relative path`);
  }
  let current = root;
  for (const [index, part] of parts.entries()) {
    current = join(current, part);
    const shown = parts.slice(0, index + 1).join("/");
    const stat = lstatSync(current, { throwIfNoEntry: false });
    if (stat?.isSymbolicLink()) throw new Error(`${shown} is a symlink`);
    if (index === parts.length - 1) break;
    if (!stat) mkdirSync(current);
    else if (!stat.isDirectory()) throw new Error(`${shown} is not a directory`);
  }
  const parent = realpathSync(join(current, ".."));
  const realRoot = realpathSync(root);
  if (parent !== realRoot && !parent.startsWith(`${realRoot}${sep}`)) throw new Error(`${path} leads outside the checkout`);
  const fd = openSync(current, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW, 0o644);
  try {
    writeSync(fd, text);
  } finally {
    closeSync(fd);
  }
}
