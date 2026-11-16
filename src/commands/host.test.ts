import { test } from "node:test";
import assert from "node:assert/strict";
import { journalSince, linesSince, parseTag, sinceDate } from "./host.ts";

const sinceCases: { value: string; expected: string }[] = [
  { value: "1d", expected: "-1d" },
  { value: "90min", expected: "-90min" },
  { value: "1h", expected: "-1h" },
  { value: "2026-11-15", expected: "2026-11-15" },
  { value: "yesterday", expected: "yesterday" },
];

for (const { value, expected } of sinceCases) {
  test(`--since ${value} reaches journalctl as ${expected}`, () => {
    assert.equal(journalSince(value), expected);
  });
}

test("accepts a release tag", () => {
  assert.equal(parseTag("v0.1.0"), "v0.1.0");
});

for (const value of ["0.1.0", "v1", "v1.2.3; reboot", "v1.2.3-rc.1", "latest"]) {
  test(`rejects the release tag ${JSON.stringify(value)}`, () => {
    assert.throws(() => parseTag(value), /not a release tag/);
  });
}

const NOW = new Date("2026-11-16T12:00:00Z");

const sinceDateCases: { value: string; expected: Date }[] = [
  { value: "1d", expected: new Date("2026-11-15T12:00:00Z") },
  { value: "90min", expected: new Date("2026-11-16T10:30:00Z") },
  { value: "2h", expected: new Date("2026-11-16T10:00:00Z") },
  { value: "30s", expected: new Date("2026-11-16T11:59:30Z") },
  { value: "1w", expected: new Date("2026-11-09T12:00:00Z") },
  { value: "2026-11-15", expected: new Date(2026, 10, 15) },
  { value: "2026-11-15T08:00:00Z", expected: new Date("2026-11-15T08:00:00Z") },
  { value: "today", expected: new Date(NOW.getFullYear(), NOW.getMonth(), NOW.getDate()) },
  { value: "yesterday", expected: new Date(NOW.getFullYear(), NOW.getMonth(), NOW.getDate() - 1) },
];

for (const { value, expected } of sinceDateCases) {
  test(`--since ${value} in a log file starts at ${expected.toISOString()}`, () => {
    assert.deepEqual(sinceDate(value, NOW), expected);
  });
}

for (const value of ["1 fortnight", "soon", "1y", ""]) {
  test(`--since ${JSON.stringify(value)} is not a time for a log file`, () => {
    assert.throws(() => sinceDate(value, NOW), /not a time/);
  });
}

const LOG = [
  "2026-11-16T09:00:00.000Z owner/app#1: claimed by host mac",
  "2026-11-16T11:00:00.000Z owner/app#2: error: boom",
  "    at stack (file.ts:1:1)",
  '{"at":"2026-11-16T11:30:00.000Z","event":"issue.claimed","issue":"owner/app#2","host":"mac"}',
  "",
].join("\n");

const linesCases: { since: string; expected: string[] }[] = [
  { since: "2026-11-16T08:00:00Z", expected: LOG.split("\n").slice(0, 4) },
  { since: "2026-11-16T10:00:00Z", expected: LOG.split("\n").slice(1, 4) },
  { since: "2026-11-16T11:15:00Z", expected: LOG.split("\n").slice(3, 4) },
  { since: "2026-11-16T12:00:00Z", expected: [] },
];

for (const { since, expected } of linesCases) {
  test(`a log file read since ${since} keeps ${expected.length} lines, with their continuation lines`, () => {
    assert.deepEqual(linesSince(LOG, new Date(since)), expected);
  });
}
