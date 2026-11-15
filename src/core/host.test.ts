import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadHost, parseClaudeConfigSource, type ClaudeConfigSource } from "./host.ts";

function writeHost(content: string): string {
  const path = join(mkdtempSync(join(tmpdir(), "autopilot-")), "host.json");
  writeFileSync(path, content);
  return path;
}

test("loads a host file and fills the defaults", () => {
  const host = loadHost(writeHost(`{ "app_id": 123456, "private_key_path": "/etc/autopilot/app.pem", "owners": ["marcaureln"], "allow": ["marcaureln"] }`));
  assert.equal(host.poll_interval_seconds, 60);
  assert.equal(host.docker, "rootless");
});

test("rejects a host file with no owners", () => {
  const path = writeHost(`{ "app_id": 123456, "private_key_path": "/etc/autopilot/app.pem", "owners": [], "allow": ["marcaureln"] }`);
  assert.throws(() => loadHost(path), /owners/);
});

test("fills the container limits", () => {
  const host = loadHost(writeHost(`{ "app_id": 1, "private_key_path": "/k.pem", "owners": ["me"], "allow": [] }`));
  assert.deepEqual(host.limits, { memory: "6g", cpus: 2, pids: 1024 });
});

const sources: { value: string; expected: ClaudeConfigSource }[] = [
  { value: "/srv/claude", expected: { kind: "path", path: "/srv/claude" } },
  { value: "github.com/me/dotfiles", expected: { kind: "github", owner: "me", repo: "dotfiles" } },
  { value: "github.com/me/dotfiles//claude", expected: { kind: "github", owner: "me", repo: "dotfiles", subdir: "claude" } },
  { value: "github.com/me/dotfiles#main", expected: { kind: "github", owner: "me", repo: "dotfiles", ref: "main" } },
  { value: "github.com/me/dot.files//a/b#v1.2", expected: { kind: "github", owner: "me", repo: "dot.files", subdir: "a/b", ref: "v1.2" } },
];

for (const { value, expected } of sources) {
  test(`claude config source ${value}`, () => {
    assert.deepEqual(parseClaudeConfigSource(value), expected);
  });
}

for (const value of ["claude", "https://github.com/me/dotfiles", "github.com/me", "github.com/me/dotfiles//../etc"]) {
  test(`rejects claude config source ${value}`, () => {
    assert.throws(() => parseClaudeConfigSource(value), /claude.config/);
  });
}
