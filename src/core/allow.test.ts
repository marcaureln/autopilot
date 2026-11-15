import { test } from "node:test";
import assert from "node:assert/strict";
import { addAllowEntry, parseAllowEntry, removeAllowEntry } from "./allow.ts";

const host = { app_id: 1, private_key_path: "/k.pem", owners: ["me"], allow: ["me"], docker: "rootless" as const, poll_interval_seconds: 60 };

test("parses owner and owner/repo entries", () => {
  assert.deepEqual(parseAllowEntry("aresmusicgroup"), { owner: "aresmusicgroup" });
  assert.deepEqual(parseAllowEntry("aresmusicgroup/amg-monorepo"), { owner: "aresmusicgroup", repo: "amg-monorepo" });
});

for (const value of ["", "a/b/c", "/repo", "owner/", "bad owner"]) {
  test(`rejects the entry "${value}"`, () => {
    assert.throws(() => parseAllowEntry(value), /owner or owner\/repo/);
  });
}

test("adds an entry once", () => {
  const once = addAllowEntry(host, "org/app");
  assert.deepEqual(once.allow, ["me", "org/app"]);
  assert.deepEqual(addAllowEntry(once, "org/app").allow, ["me", "org/app"]);
});

test("removes an entry, and fails for an unknown one", () => {
  assert.deepEqual(removeAllowEntry(host, "me").allow, []);
  assert.throws(() => removeAllowEntry(host, "other"), /not in the allowlist/);
});
