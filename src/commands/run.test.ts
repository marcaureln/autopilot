import { test } from "node:test";
import assert from "node:assert/strict";
import type { FoundIssue, GitHub, Issue, RepoGitHub } from "../core/github.ts";
import { changesOnly, drain, loopState, pollOnce } from "./run.ts";

function unused(): never {
  throw new Error("not called for an issue in a builder state");
}

function repoWith(issues: Issue[]): RepoGitHub {
  return {
    listOpenIssues: async () => issues,
    lastLabeled: unused,
    listComments: unused,
    postComment: unused,
    deleteComment: unused,
    setLabels: unused,
    closeIssue: unused,
    ensureLabels: async () => undefined,
    readFile: unused,
    minimizeOutdated: unused,
    commentEditors: unused,
    provenance: unused,
    token: unused,
    canChangeWorkflows: unused,
    defaultBranch: unused,
    isEmpty: unused,
    lastUnlabeled: unused,
    userId: unused,
    botPulls: async () => [],
    onboardingPull: unused,
    pullFiles: unused,
    pullCommits: unused,
    statuses: unused,
    ciStatuses: unused,
    ciOutput: unused,
    setStatus: unused,
    markPushed: unused,
    pushedFor: unused,
    compare: unused,
    rebasePull: unused,
    pullHead: unused,
    openPull: unused,
    requestReview: unused,
    mergePull: unused,
  };
}

const BLOCKED: Issue = { number: 7, title: "Add CONTRIBUTING.md", body: "", labels: ["autopilot", "autopilot:blocked"] };

function searchFindsAppA(query: string): FoundIssue[] {
  if (query.includes("is:closed")) return [];
  return query.split(" ").flatMap((term) => {
    const [kind = "", scope = ""] = term.split(":");
    const [owner = "", name] = scope.split("/");
    const names = kind === "user" ? ["app-a", "app-b"] : kind === "repo" && name ? [name] : [];
    return names.filter((candidate) => candidate === "app-a").map((candidate) => ({ repo: { owner, name: candidate }, issue: BLOCKED }));
  });
}

const github: GitHub = {
  app: unused,
  appSlug: async () => "autopilot",
  appLogin: async () => "autopilot[bot]",
  findInstallation: async (entry) => (entry.owner === "owner" || entry.owner === "org" ? 1 : undefined),
  canChangeWorkflows: unused,
  rateLimit: unused,
  listRepos: async (_, owner) => [
    { owner, name: "app-a" },
    { owner, name: "app-b" },
  ],
  searchIssues: async (_, query) => searchFindsAppA(query),
  repo: (_, repo) => repoWith(repo.name === "app-a" ? [BLOCKED] : []),
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
  await pollOnce({ github, host: { ...host, allow }, plan: unused, build: unused, check: unused, onboard: unused, log: (_, line) => lines.push(line), audit: unused, idle: { due: () => false, run: unused } }, state);
  await drain(state);
  return lines;
}

test("an owner entry visits labeled issues in every repo of that owner", async () => {
  assert.deepEqual(await linesFor(["owner"]), ["owner/app-a#7: blocked", "polled (open issues: 1, repos: 1)"]);
});

test("a repo entry visits only that repo", async () => {
  assert.deepEqual(await linesFor(["org/app-b"]), ["polled (open issues: 0, repos: 0)"]);
  assert.deepEqual(await linesFor(["org/app-a"]), ["org/app-a#7: blocked", "polled (open issues: 1, repos: 1)"]);
});

test("an entry where the App is not installed is reported, not polled", async () => {
  assert.deepEqual(await linesFor(["stranger"]), ["not installed: stranger", "polled (open issues: 0, repos: 0)"]);
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
  const loop = { github: { ...github, repo: () => repo }, host: { ...host, allow: ["owner/app-a"], concurrency }, plan: unused, build: unused, check: unused, onboard: unused, log: () => undefined, audit: unused, idle: { due: () => false, run: unused } };
  await pollOnce(loop, state);
  await pollOnce(loop, state);
  resolve();
  await drain(state);
  return started;
}

test("the loop runs at most `concurrency` issues at once and never one issue twice", async () => {
  assert.deepEqual(await startedWith(1), [1]);
  assert.deepEqual(await startedWith(2), [1, 2]);
  assert.deepEqual(await startedWith(5), [1, 2, 3]);
});

test("an error on one repo is logged and the other repos are still polled", async () => {
  const lines: string[] = [];
  const broken: RepoGitHub = { ...repoWith([]), listOpenIssues: async () => Promise.reject(new Error("HTTP 410: issues are off")) };
  const other: Issue = { number: 9, title: "x", body: "", labels: ["autopilot", "autopilot:blocked"] };
  const found = [
    { repo: { owner: "owner", name: "app-a" }, issue: BLOCKED },
    { repo: { owner: "owner", name: "app-b" }, issue: other },
  ];
  const loop = {
    github: {
      ...github,
      searchIssues: async (_: number, query: string) => (query.includes("is:open") ? found : []),
      repo: (_: number, repo: { name: string }) => (repo.name === "app-a" ? broken : repoWith([other])),
    },
    host: { ...host, allow: ["owner"] },
    plan: unused,
    build: unused,
    check: unused,
    onboard: unused,
    log: (_: string, line: string) => lines.push(line),
    audit: unused,
    idle: { due: () => false, run: unused },
  };
  const state = loopState();
  await pollOnce(loop, state);
  await drain(state);
  assert.deepEqual(lines, ["owner/app-a: error: HTTP 410: issues are off", "owner/app-b#9: blocked", "polled (open issues: 2, repos: 2)"]);
});
