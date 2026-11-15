import { test } from "node:test";
import assert from "node:assert/strict";
import { addAllowEntry, overlaps, parseAllowEntry, removeAllowEntry } from "./allow.ts";

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

const conflictCases: { entry: string; taken: string; conflict: boolean }[] = [
  { entry: "org", taken: "org", conflict: true },
  { entry: "org/app", taken: "org/app", conflict: true },
  { entry: "org/app", taken: "org", conflict: true },
  { entry: "org", taken: "org/app", conflict: true },
  { entry: "org/app", taken: "org/web", conflict: false },
  { entry: "org", taken: "other", conflict: false },
];

for (const { entry, taken, conflict } of conflictCases) {
  test(`${entry} ${conflict ? "conflicts" : "does not conflict"} with ${taken} on another host`, () => {
    assert.equal(overlaps(parseAllowEntry(entry), parseAllowEntry(taken)), conflict);
  });
}
