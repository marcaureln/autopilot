import { execFileSync } from "node:child_process";

export type Repo = { owner: string; name: string };

const GITHUB_REMOTE = /^(?:https:\/\/(?:[^@/]+@)?github\.com\/|git@github\.com:|ssh:\/\/git@github\.com(?::\d+)?\/)([^/]+)\/([^/]+?)(?:\.git)?\/?$/;

export function parseRemote(url: string): Repo {
  const match = GITHUB_REMOTE.exec(url);
  if (!match?.[1] || !match[2]) {
    throw new Error(`${url} is not a GitHub repo URL`);
  }
  return { owner: match[1], name: match[2] };
}

export function detectRepo(cwd = process.cwd()): Repo {
  return parseRemote(execFileSync("git", ["remote", "get-url", "origin"], { cwd, encoding: "utf8" }).trim());
}
