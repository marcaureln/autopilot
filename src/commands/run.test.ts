import { test } from "node:test";
import assert from "node:assert/strict";
import type { GitHub, RepoGitHub } from "../core/github.ts";
import { changesOnly, drain, loopState, runOnce } from "./run.ts";

function unused(): never {
  throw new Error("not called for an issue in a builder state");
}

function repoWith(issues: Awaited<ReturnType<RepoGitHub["listLabeledIssues"]>>): RepoGitHub {
  return {
    listLabeledIssues: async (_, state) => (state === "open" ? issues : []),
    lastLabeled: unused,
    listComments: unused,
    postComment: unused,
    deleteComment: unused,
    setLabels: unused,
    ensureLabels: async () => undefined,
    readFile: unused,
    minimizeOutdated: unused,
    commentEditors: unused,
    provenance: unused,
    token: unused,
    defaultBranch: unused,
    lastUnlabeled: unused,
    userId: unused,
    botPulls: async () => [],
    pullFiles: unused,
    pullCommits: unused,
    statuses: unused,
    setStatus: unused,
    markPushed: unused,
    pushedFor: unused,
    compare: unused,
    rebasePull: unused,
    openPull: unused,
    requestReview: unused,
    mergePull: unused,
  };
}

const github: GitHub = {
  appSlug: async () => "autopilot",
  appLogin: async () => "autopilot[bot]",
  findInstallation: async (entry) => (entry.owner === "owner" || entry.owner === "org" ? 1 : undefined),
  listRepos: async (_, owner) => [
    { owner, name: "app-a" },
    { owner, name: "app-b" },
  ],
  repo: (_, repo) => repoWith(repo.name === "app-a" ? [{ number: 7, title: "Add CONTRIBUTING.md", body: "", labels: ["autopilot", "autopilot:blocked"] }] : []),
};

const host = {
  name: "pi",
  app_id: 1,
  secrets: { app_key: "op://v/k/f", claude_token: "op://v/c/f" },
  owners: ["owner"],
  allow: [],
  docker: "rootless" as const,
  poll_interval_seconds: 60,
  concurrency: 1,
  limits: { memory: "6g", cpus: 2, pids: 1024 },
};

async function linesFor(allow: string[]): Promise<string[]> {
  const lines: string[] = [];
  const state = loopState();
  await runOnce({ github, host: { ...host, allow }, plan: unused, build: unused, check: unused, log: (_, line) => lines.push(line), audit: unused, idle: { due: () => false, run: unused } }, state);
  await drain(state);
  return lines;
}

test("an owner entry visits labeled issues in every repo of that owner", async () => {
  assert.deepEqual(await linesFor(["owner"]), ["owner/app-a#7: blocked"]);
});

test("a repo entry visits only that repo", async () => {
  assert.deepEqual(await linesFor(["org/app-b"]), []);
  assert.deepEqual(await linesFor(["org/app-a"]), ["org/app-a#7: blocked"]);
});

test("an entry where the App is not installed is reported, not polled", async () => {
  assert.deepEqual(await linesFor(["stranger"]), ["not installed: stranger"]);
});

test("the log prints a line only when it changes for its key", () => {
  const printed: string[] = [];
  const log = changesOnly((line) => printed.push(line));
  log("a#1", "a#1: spec");
  log("a#1", "a#1: spec");
  log("b#2", "b#2: spec");
  log("a#1", "a#1: building");
  log("a#1", "a#1: building");
  assert.deepEqual(printed, ["a#1: spec", "b#2: spec", "a#1: building"]);
});

async function startedWith(concurrency: number): Promise<number[]> {
  const started: number[] = [];
  const { promise: release, resolve } = Promise.withResolvers<void>();
  const working = (number: number) => ({ number, title: `Issue ${number}`, body: "", labels: ["autopilot", "autopilot:working"] });
  const repo: RepoGitHub = {
    ...repoWith([working(1), working(2), working(3)]),
    lastLabeled: async (issue) => {
      started.push(issue);
      await release;
      return undefined;
    },
  };
  const state = loopState();
  const loop = { github: { ...github, repo: () => repo }, host: { ...host, allow: ["owner/app-a"], concurrency }, plan: unused, build: unused, check: unused, log: () => undefined, audit: unused, idle: { due: () => false, run: unused } };
  await runOnce(loop, state);
  await runOnce(loop, state);
  resolve();
  await drain(state);
  return started;
}

test("the loop runs at most `concurrency` issues at once and never one issue twice", async () => {
  assert.deepEqual(await startedWith(1), [1]);
  assert.deepEqual(await startedWith(2), [1, 2]);
  assert.deepEqual(await startedWith(5), [1, 2, 3]);
});
