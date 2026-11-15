import { test } from "node:test";
import assert from "node:assert/strict";
import type { GitHub } from "../core/github.ts";
import { runOnce } from "./run.ts";

const github: GitHub = {
  listInstallations: async () => [
    { id: 1, account: "marcaureln" },
    { id: 2, account: "stranger" },
  ],
  listRepos: async (installationId) =>
    installationId === 1
      ? [
          { owner: "marcaureln", name: "app-a" },
          { owner: "marcaureln", name: "app-b" },
        ]
      : [{ owner: "stranger", name: "evil" }],
  listLabeledIssues: async (_, repo) => (repo.name === "app-a" ? [{ number: 7, title: "Add CONTRIBUTING.md" }] : []),
};

const host = { app_id: 1, private_key_path: "/k.pem", owners: ["marcaureln"], installations: ["marcaureln"], poll_interval_seconds: 60 };

test("lists labeled issues on allowed installations and ignores the others", async () => {
  const lines: string[] = [];
  await runOnce(github, host, undefined, (line) => lines.push(line));
  assert.deepEqual(lines, ["marcaureln/app-a#7 Add CONTRIBUTING.md", "ignoring installation 2 (stranger): not in installations"]);
});

test("--repo limits the loop to one repo", async () => {
  const lines: string[] = [];
  await runOnce(github, host, { owner: "marcaureln", name: "app-b" }, (line) => lines.push(line));
  assert.deepEqual(lines, ["ignoring installation 2 (stranger): not in installations"]);
});
