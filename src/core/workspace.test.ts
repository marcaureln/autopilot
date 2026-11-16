import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readAgentFile, writeRepoFile } from "./workspace.ts";

const MAX = 64;

function work(): string {
  return mkdtempSync(join(tmpdir(), "autopilot-work-"));
}

const outside = join(mkdtempSync(join(tmpdir(), "autopilot-host-")), "secret.txt");
writeFileSync(outside, "host secret");

const cases: { name: string; setup: (dir: string) => void; expected: string | undefined | RegExp }[] = [
  { name: "a regular file", setup: (dir) => (mkdirSync(join(dir, ".autopilot")), writeFileSync(join(dir, ".autopilot", "result.json"), "{}")), expected: "{}" },
  { name: "no result file", setup: (dir) => mkdirSync(join(dir, ".autopilot")), expected: undefined },
  { name: "no .autopilot directory", setup: () => undefined, expected: undefined },
  {
    name: "the file is a symlink to a host file",
    setup: (dir) => (mkdirSync(join(dir, ".autopilot")), symlinkSync(outside, join(dir, ".autopilot", "result.json"))),
    expected: /not a regular file/,
  },
  { name: "the directory is a symlink", setup: (dir) => symlinkSync(join(outside, ".."), join(dir, ".autopilot")), expected: /not a directory/ },
  {
    name: "the file is a FIFO",
    setup: (dir) => (mkdirSync(join(dir, ".autopilot")), execFileSync("mkfifo", [join(dir, ".autopilot", "result.json")])),
    expected: /not a regular file/,
  },
  {
    name: "the file is too large",
    setup: (dir) => (mkdirSync(join(dir, ".autopilot")), writeFileSync(join(dir, ".autopilot", "result.json"), "x".repeat(MAX + 1))),
    expected: /larger than 64 bytes/,
  },
];

for (const { name, setup, expected } of cases) {
  test(`agent file: ${name}`, () => {
    const dir = work();
    setup(dir);
    if (expected instanceof RegExp) assert.throws(() => readAgentFile(dir, ".autopilot/result.json", MAX), expected);
    else assert.equal(readAgentFile(dir, ".autopilot/result.json", MAX), expected);
  });
}

const writeCases: { name: string; path: string; setup: (dir: string) => void; expected: RegExp | undefined }[] = [
  { name: "a new file in new directories", path: ".github/autopilot.json", setup: () => undefined, expected: undefined },
  { name: "an existing file", path: "AGENTS.md", setup: (dir) => writeFileSync(join(dir, "AGENTS.md"), "old text that is longer"), expected: undefined },
  { name: "a symlinked directory", path: ".github/autopilot.json", setup: (dir) => symlinkSync(join(outside, ".."), join(dir, ".github")), expected: /\.github is a symlink/ },
  { name: "a symlinked file", path: "AGENTS.md", setup: (dir) => symlinkSync(outside, join(dir, "AGENTS.md")), expected: /AGENTS\.md is a symlink/ },
  { name: "a file where a directory goes", path: ".github/autopilot.json", setup: (dir) => writeFileSync(join(dir, ".github"), ""), expected: /\.github is not a directory/ },
  { name: "a parent path", path: "../x", setup: () => undefined, expected: /not a plain relative path/ },
  { name: "an inner parent path", path: "a/../b", setup: () => undefined, expected: /not a plain relative path/ },
  { name: "an absolute path", path: "/tmp/x", setup: () => undefined, expected: /not a plain relative path/ },
  { name: "an empty segment", path: "a//b", setup: () => undefined, expected: /not a plain relative path/ },
];

for (const { name, path, setup, expected } of writeCases) {
  test(`repo file write: ${name}`, () => {
    const dir = work();
    setup(dir);
    if (expected) assert.throws(() => writeRepoFile(dir, path, "new"), expected);
    else {
      writeRepoFile(dir, path, "new");
      assert.equal(readFileSync(join(dir, path), "utf8"), "new");
    }
    assert.equal(readFileSync(outside, "utf8"), "host secret");
  });
}
