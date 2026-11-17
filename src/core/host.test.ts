import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultHostName, hostSecretFiles, loadHost, parseSource, type Host, type HostSecretFile, type Source } from "./host.ts";
import { hostLayout, type Layout } from "./layout.ts";

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

const sources: { value: string; expected: Source }[] = [
  { value: "/srv/claude", expected: { kind: "path", path: "/srv/claude" } },
  { value: "github.com/me/dotfiles", expected: { kind: "github", owner: "me", repo: "dotfiles" } },
  { value: "github.com/me/dotfiles//claude", expected: { kind: "github", owner: "me", repo: "dotfiles", subdir: "claude" } },
  { value: "github.com/me/dotfiles#main", expected: { kind: "github", owner: "me", repo: "dotfiles", ref: "main" } },
  { value: "github.com/me/dot.files//a/b#v1.2", expected: { kind: "github", owner: "me", repo: "dot.files", subdir: "a/b", ref: "v1.2" } },
];

for (const { value, expected } of sources) {
  test(`claude config source ${value}`, () => {
    assert.deepEqual(parseSource(value), expected);
  });
}

for (const value of ["claude", "https://github.com/me/dotfiles", "github.com/me", "github.com/me/dotfiles//../etc"]) {
  test(`rejects claude config source ${value}`, () => {
    assert.throws(() => parseSource(value), /claude.config/);
  });
}

const LINUX = hostLayout("linux", "/home/me");
const MAC = hostLayout("darwin", "/Users/me");
const OP_APP_KEY = "op://autopilot/github-app-private-key/app.pem";
const OP_CLAUDE = "op://autopilot/claude-token/credential";

const secretFileCases: { name: string; secrets: Host["secrets"]; layout: Layout; expected: HostSecretFile[] }[] = [
  {
    name: "files on Linux",
    secrets: { app_key: "file:app-key.pem", claude_token: "file:claude-token" },
    layout: LINUX,
    expected: [
      { secret: "app_key", path: "/etc/autopilot/secrets/app-key.pem" },
      { secret: "claude_token", path: "/etc/autopilot/secrets/claude-token" },
    ],
  },
  {
    name: "files on macOS",
    secrets: { app_key: "file:app-key.pem", claude_token: "file:claude-token" },
    layout: MAC,
    expected: [
      { secret: "app_key", path: "/Users/me/.autopilot/secrets/app-key.pem" },
      { secret: "claude_token", path: "/Users/me/.autopilot/secrets/claude-token" },
    ],
  },
  { name: "1Password only", secrets: { app_key: OP_APP_KEY, claude_token: OP_CLAUDE }, layout: LINUX, expected: [{ secret: "op_token", path: "/etc/autopilot/op-token" }] },
  {
    name: "a file and a 1Password reference",
    secrets: { app_key: OP_APP_KEY, claude_token: "file:claude-token" },
    layout: MAC,
    expected: [
      { secret: "op_token", path: "/Users/me/.autopilot/op-token" },
      { secret: "claude_token", path: "/Users/me/.autopilot/secrets/claude-token" },
    ],
  },
];

for (const { name, secrets, layout, expected } of secretFileCases) {
  test(`host secret files: ${name}`, () => {
    assert.deepEqual(hostSecretFiles(secrets, layout), expected);
  });
}
