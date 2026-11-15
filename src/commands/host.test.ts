import { test } from "node:test";
import assert from "node:assert/strict";
import { journalSince, parseTag } from "./host.ts";

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
