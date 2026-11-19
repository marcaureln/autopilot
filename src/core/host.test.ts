import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addApiKeys, defaultHostName, hostSecretFiles, loadHost, parseSource, type Host, type HostSecretFile, type Source } from "./host.ts";
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
  {
    name: "an API key in 1Password",
    secrets: { app_key: "file:app-key.pem", claude_token: "file:claude-token", api_keys: { OPENAI_API_KEY: "op://v/openai/credential" } },
    layout: LINUX,
    expected: [
      { secret: "op_token", path: "/etc/autopilot/op-token" },
      { secret: "app_key", path: "/etc/autopilot/secrets/app-key.pem" },
      { secret: "claude_token", path: "/etc/autopilot/secrets/claude-token" },
    ],
  },
  {
    name: "API keys: files only",
    secrets: { app_key: "file:app-key.pem", claude_token: "file:claude-token", api_keys: { OPENAI_API_KEY: "file:openai_api_key", GEMINI_API_KEY: "op://v/gemini/credential" } },
    layout: LINUX,
    expected: [
      { secret: "op_token", path: "/etc/autopilot/op-token" },
      { secret: "app_key", path: "/etc/autopilot/secrets/app-key.pem" },
      { secret: "claude_token", path: "/etc/autopilot/secrets/claude-token" },
      { secret: "api_key:OPENAI_API_KEY", path: "/etc/autopilot/secrets/openai_api_key" },
    ],
  },
  {
    name: "an API key file with no 1Password",
    secrets: { app_key: "file:app-key.pem", claude_token: "file:claude-token", api_keys: { OPENAI_API_KEY: "file:openai_api_key" } },
    layout: MAC,
    expected: [
      { secret: "app_key", path: "/Users/me/.autopilot/secrets/app-key.pem" },
      { secret: "claude_token", path: "/Users/me/.autopilot/secrets/claude-token" },
      { secret: "api_key:OPENAI_API_KEY", path: "/Users/me/.autopilot/secrets/openai_api_key" },
    ],
  },
];

for (const { name, secrets, layout, expected } of secretFileCases) {
  test(`host secret files: ${name}`, () => {
    assert.deepEqual(hostSecretFiles(secrets, layout), expected);
  });
}

const apiKeyCases: { name: string; apiKeys: Record<string, string>; valid: boolean }[] = [
  { name: "a file reference", apiKeys: { ANTHROPIC_API_KEY: "file:anthropic-api-key" }, valid: true },
  { name: "a 1Password reference", apiKeys: { OPENAI_API_KEY: "op://v/openai/credential" }, valid: true },
  { name: "a value instead of a reference", apiKeys: { ANTHROPIC_API_KEY: "sk-ant-secret" }, valid: false },
  { name: "a name that is not an env var", apiKeys: { "anthropic-key": "file:anthropic-api-key" }, valid: false },
];

for (const { name, apiKeys, valid } of apiKeyCases) {
  test(`api_keys: ${name}`, () => {
    const secrets = { app_key: "op://v/key/app.pem", claude_token: "op://v/claude/credential", api_keys: apiKeys };
    const path = writeHost(JSON.stringify({ app_id: 1, secrets, owners: ["me"], allow: [] }));
    if (valid) assert.deepEqual(loadHost(path).secrets.api_keys, apiKeys);
    else assert.throws(() => loadHost(path), /api_keys/);
  });
}

const FILES = { app_key: "file:app-key.pem", claude_token: "file:claude-token" };

const addApiKeysCases: { name: string; apiKeys?: Record<string, string>; names: string[]; changed: boolean; expected: Record<string, string> | undefined }[] = [
  { name: "adds a key to a host with none", names: ["OPENAI_API_KEY"], changed: true, expected: { OPENAI_API_KEY: "file:openai_api_key" } },
  {
    name: "adds a key next to another",
    apiKeys: { ANTHROPIC_API_KEY: "file:anthropic-api-key" },
    names: ["OPENAI_API_KEY"],
    changed: true,
    expected: { ANTHROPIC_API_KEY: "file:anthropic-api-key", OPENAI_API_KEY: "file:openai_api_key" },
  },
  { name: "adds several keys", names: ["A_KEY", "B_KEY"], changed: true, expected: { A_KEY: "file:a_key", B_KEY: "file:b_key" } },
  { name: "keeps a reference that exists", apiKeys: { OPENAI_API_KEY: "op://v/openai/credential" }, names: ["OPENAI_API_KEY"], changed: false, expected: { OPENAI_API_KEY: "op://v/openai/credential" } },
  { name: "no name changes nothing", names: [], changed: false, expected: undefined },
];

for (const { name, apiKeys, names, changed, expected } of addApiKeysCases) {
  test(`add API keys: ${name}`, () => {
    const text = JSON.stringify({ app_id: 1, secrets: { ...FILES, ...(apiKeys && { api_keys: apiKeys }) }, owners: ["me"], allow: [] }, null, 2) + "\n";
    const updated = addApiKeys(text, names);
    assert.deepEqual(JSON.parse(updated).secrets.api_keys, expected);
    assert.equal(updated !== text, changed);
  });
}
