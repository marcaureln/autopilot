import { test } from "node:test";
import assert from "node:assert/strict";
import { addWatchEntry, parseWatchEntry, removeWatchEntry, searchQuery } from "./allow.ts";

const host = { name: "pi", app_id: 1, secrets: { app_key: "file:k", claude_token: "file:c" }, owners: ["me"], allow: ["me"], docker: "rootless" as const, poll_interval_seconds: 60, concurrency: 1, limits: { memory: "6g", cpus: 2, pids: 1024 } };

test("parses owner and owner/repo entries", () => {
  assert.deepEqual(parseWatchEntry("example-org"), { owner: "example-org" });
  assert.deepEqual(parseWatchEntry("example-org/app"), { owner: "example-org", repo: "app" });
});

for (const value of ["", "a/b/c", "/repo", "owner/", "bad owner"]) {
  test(`rejects the entry "${value}"`, () => {
    assert.throws(() => parseWatchEntry(value), /owner or owner\/repo/);
  });
}

test("adds an entry once", () => {
  const once = addWatchEntry(host, "org/app");
  assert.deepEqual(once.allow, ["me", "org/app"]);
  assert.deepEqual(addWatchEntry(once, "org/app").allow, ["me", "org/app"]);
});

test("removes an entry, and fails for an unknown one", () => {
  assert.deepEqual(removeWatchEntry(host, "me").allow, []);
  assert.throws(() => removeWatchEntry(host, "other"), /the host does not watch other/);
});

for (const row of [
  { state: "open", entries: ["me"], query: "label:autopilot is:issue is:open user:me" },
  { state: "closed", entries: ["example-org/app"], query: "label:autopilot is:issue is:closed repo:example-org/app" },
  { state: "open", entries: ["me", "example-org/app", "example-org/api"], query: "label:autopilot is:issue is:open user:me repo:example-org/app repo:example-org/api" },
] as const) {
  test(`the search for ${row.state} issues of ${row.entries.join(", ")}`, () => {
    assert.equal(searchQuery(row.state, row.entries.map(parseWatchEntry)), row.query);
  });
}
