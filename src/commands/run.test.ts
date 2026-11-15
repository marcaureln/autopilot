import { test } from "node:test";
import assert from "node:assert/strict";
import type { GitHub } from "../core/github.ts";
import { runOnce } from "./run.ts";

const github: GitHub = {
  findInstallation: async (entry) => (entry.owner === "marcaureln" || entry.owner === "org" ? 1 : undefined),
  listRepos: async (_, owner) => [
    { owner, name: "app-a" },
    { owner, name: "app-b" },
  ],
  listLabeledIssues: async (_, repo) => (repo.name === "app-a" ? [{ number: 7, title: "Add CONTRIBUTING.md" }] : []),
};

const host = { app_id: 1, private_key_path: "/k.pem", owners: ["marcaureln"], allow: [], docker: "rootless" as const, poll_interval_seconds: 60, limits: { memory: "6g", cpus: 2, pids: 1024 } };

async function linesFor(allow: string[]): Promise<string[]> {
  const lines: string[] = [];
  await runOnce(github, { ...host, allow }, (line) => lines.push(line));
  return lines;
}

test("an owner entry lists labeled issues in every repo of that owner", async () => {
  assert.deepEqual(await linesFor(["marcaureln"]), ['marcaureln/app-a#7 "Add CONTRIBUTING.md"']);
});

test("a repo entry lists only that repo", async () => {
  assert.deepEqual(await linesFor(["org/app-b"]), []);
  assert.deepEqual(await linesFor(["org/app-a"]), ['org/app-a#7 "Add CONTRIBUTING.md"']);
});

test("an entry where the App is not installed is reported, not polled", async () => {
  assert.deepEqual(await linesFor(["stranger"]), ["not installed: stranger"]);
});
