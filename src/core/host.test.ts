import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultHostName, loadHost, parseClaudeConfigSource, type ClaudeConfigSource } from "./host.ts";

const SECRETS = `"secrets": { "app_key": "op://v/key/app.pem", "claude_token": "op://v/claude/credential" }`;

function writeHost(content: string): string {
  const path = join(mkdtempSync(join(tmpdir(), "autopilot-")), "host.json");
  writeFileSync(path, content);
  return path;
}

test("loads a host file and fills the defaults", () => {
  const host = loadHost(writeHost(`{ "app_id": 123456, ${SECRETS}, "owners": ["marcaureln"], "allow": ["marcaureln"] }`));
  assert.equal(host.poll_interval_seconds, 60);
  assert.equal(host.docker, "rootless");
});

test("names the host after its short hostname unless the file names it", () => {
  const unnamed = loadHost(writeHost(`{ "app_id": 1, ${SECRETS}, "owners": ["me"], "allow": [] }`));
  assert.equal(unnamed.name, defaultHostName());
  const named = loadHost(writeHost(`{ "name": "pi", "app_id": 1, ${SECRETS}, "owners": ["me"], "allow": [] }`));
  assert.equal(named.name, "pi");
});

test("rejects a secret that is not a 1Password reference", () => {
  const path = writeHost(`{ "app_id": 1, "secrets": { "app_key": "/etc/autopilot/app-key", "claude_token": "op://v/c/f" }, "owners": ["me"], "allow": [] }`);
  assert.throws(() => loadHost(path), /app_key/);
});

test("rejects a host file with no owners", () => {
  const path = writeHost(`{ "app_id": 123456, ${SECRETS}, "owners": [], "allow": ["marcaureln"] }`);
  assert.throws(() => loadHost(path), /owners/);
});

test("fills the container limits", () => {
  const host = loadHost(writeHost(`{ "app_id": 1, ${SECRETS}, "owners": ["me"], "allow": [] }`));
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
