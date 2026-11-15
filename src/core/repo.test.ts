import { test } from "node:test";
import assert from "node:assert/strict";
import { parseRemote } from "./repo.ts";

const valid = [
  "https://github.com/marcaureln/autopilot.git",
  "https://github.com/marcaureln/autopilot",
  "https://github.com/marcaureln/autopilot/",
  "https://user@github.com/marcaureln/autopilot.git",
  "git@github.com:marcaureln/autopilot.git",
  "git@github.com:marcaureln/autopilot",
  "ssh://git@github.com/marcaureln/autopilot.git",
  "ssh://git@github.com:22/marcaureln/autopilot.git",
];

for (const url of valid) {
  test(`parses ${url}`, () => {
    assert.deepEqual(parseRemote(url), { owner: "marcaureln", name: "autopilot" });
  });
}

const invalid = ["https://gitlab.com/marcaureln/autopilot.git", "git@gitlab.com:marcaureln/autopilot.git", "/home/me/autopilot", "https://github.com/marcaureln"];

for (const url of invalid) {
  test(`rejects ${url}`, () => {
    assert.throws(() => parseRemote(url), /not a GitHub repo/);
  });
}
