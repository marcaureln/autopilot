import { test } from "node:test";
import assert from "node:assert/strict";
import { parseConfig } from "./config.ts";

const FULL_CONFIG = `{
  "version": 1,
  "agents": {
    "planner": { "harness": "claude", "model": "claude-opus-5-5", "effort": "high" },
    "builder": { "harness": "claude", "model": "claude-sonnet-5-5" }
  },
  "steps": { "spec": "planner", "build": "builder", "fix": "builder" },
  "skills": {
    "planner": ["github.com/example-org/skills//architect#main"],
    "builder": [
      "github.com/example-org/skills//poteto-mode#main",
      "github.com/example-org/skills//test-driven-development#v1.2.0",
      "/etc/autopilot/skills/systematic-debugging"
    ]
  },
  "verify": {
    "mode": "host",
    "required": ["lint", "types", "test", "sast", "deps-scan", "secrets-scan"],
    "commands": { "lint": "npm run lint", "types": "npx tsc --noEmit", "test": "npm test" },
    "timeout_minutes": 10
  },
  "preview": { "command": "npm run dev", "url": "http://localhost:3000" },
  "merge": "auto",
  "risk": { "high_paths": ["src/auth/**"], "max_diff_lines": 500 },
  "limits": { "fix_rounds": 3, "run_timeout_minutes": 45 }
}`;

test("loads a config that sets every field", () => {
  const config = parseConfig(FULL_CONFIG, "full");
  assert.equal(config.merge, "auto");
  assert.deepEqual(config.risk, { high_paths: ["src/auth/**"], max_diff_lines: 500 });
});

test("fills every default in a minimal config", () => {
  const config = parseConfig(`{ "version": 1 }`, "minimal");
  assert.deepEqual(config, {
    version: 1,
    agents: {
      planner: { harness: "claude", model: "claude-opus-5-5", effort: "high" },
      builder: { harness: "claude", model: "claude-sonnet-5-5" },
    },
    steps: { spec: "planner", build: "builder", fix: "builder" },
    skills: { planner: [], builder: [] },
    verify: {
      mode: "host",
      required: ["lint", "types", "test", "sast", "deps-scan", "secrets-scan"],
      commands: {},
      timeout_minutes: 10,
    },
    merge: "manual",
    risk: { high_paths: [], max_diff_lines: 500 },
    limits: { fix_rounds: 3, run_timeout_minutes: 45 },
  });
});

test("rejects an invalid config and names the bad field", () => {
  assert.throws(() => parseConfig(`{ "version": 1, "merge": "yolo" }`, "test"), /merge/);
});

test("refuses 1Password references and says how to set the secrets again", () => {
  const text = `{ "version": 1, "secrets": { "K": "op://autopilot/o_r/K" } }`;
  assert.throws(() => parseConfig(text, "test"), /1Password is no longer supported.*autopilot secrets set/s);
});

for (const secrets of [`{}`, `{ "K": "sk_live_123" }`]) {
  test(`rejects a secrets key that is ${secrets}`, () => {
    assert.throws(() => parseConfig(`{ "version": 1, "secrets": ${secrets} }`, "test"), /Invalid config test.*additional properties/);
  });
}

test("rejects a config that is not JSON and names the source", () => {
  assert.throws(() => parseConfig(`{ "version": 1, }`, ".github/autopilot.json"), /Invalid config \.github\/autopilot\.json: /);
});

test("a config from the stack packs asks for a new autopilot init", () => {
  assert.throws(() => parseConfig(`{ "version": 1, "stack": ["node"] }`, ".github/autopilot.json"), /Invalid config \.github\/autopilot\.json: `stack` .*Run `autopilot init` again/);
});

const agentCases: { name: string; agent: Record<string, string>; valid: boolean }[] = [
  { name: "a Claude model", agent: { harness: "claude", model: "claude-sonnet-5-5" }, valid: true },
  { name: "an OpenCode model with its provider", agent: { harness: "opencode", model: "anthropic/claude-sonnet-5-5", effort: "high" }, valid: true },
  { name: "an OpenCode model with a slash in its name", agent: { harness: "opencode", model: "openrouter/moonshot/kimi-k3" }, valid: true },
  { name: "an OpenCode model without a provider", agent: { harness: "opencode", model: "claude-sonnet-5-5" }, valid: false },
  { name: "an OpenCode model with a variant, which is the effort", agent: { harness: "opencode", model: "anthropic/claude-sonnet-5-5#high" }, valid: false },
  { name: "an unknown harness", agent: { harness: "codex", model: "gpt-6" }, valid: false },
];

for (const { name, agent, valid } of agentCases) {
  test(`agent: ${name}`, () => {
    const text = JSON.stringify({ version: 1, agents: { planner: agent, builder: { harness: "claude", model: "claude-sonnet-5-5" } } });
    if (valid) assert.deepEqual(parseConfig(text, "test").agents.planner, agent);
    else assert.throws(() => parseConfig(text, "test"), /agents\/planner/);
  });
}
