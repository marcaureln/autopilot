import { test } from "node:test";
import assert from "node:assert/strict";
import { addWatchEntry, parseWatchEntry, removeWatchEntry } from "./allow.ts";

const host = { name: "pi", app_id: 1, secrets: { app_key: "op://v/k/f", claude_token: "op://v/c/f" }, owners: ["me"], allow: ["me"], docker: "rootless" as const, poll_interval_seconds: 60, concurrency: 1, limits: { memory: "6g", cpus: 2, pids: 1024 } };

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
  assert.throws(() => removeWatchEntry(host, "other"), /is not watched/);
});
