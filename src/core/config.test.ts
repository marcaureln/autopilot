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
  "secrets": { "STRIPE_KEY": "op://autopilot/example-org_app-a/STRIPE_KEY" },
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
    secrets: {},
    limits: { fix_rounds: 3, run_timeout_minutes: 45 },
  });
});

test("rejects an invalid config and names the bad field", () => {
  assert.throws(() => parseConfig(`{ "version": 1, "merge": "yolo" }`, "test"), /merge/);
});

test("rejects a secret value that is not an op:// reference", () => {
  assert.throws(() => parseConfig(`{ "version": 1, "secrets": { "STRIPE_KEY": "sk_live_123" } }`, "test"), /secrets/);
});

test("rejects a config that is not JSON and names the source", () => {
  assert.throws(() => parseConfig(`{ "version": 1, }`, ".github/autopilot.json"), /Invalid config \.github\/autopilot\.json: /);
});

test("a config from the stack packs asks for a new autopilot init", () => {
  assert.throws(() => parseConfig(`{ "version": 1, "stack": ["node"] }`, ".github/autopilot.json"), /Invalid config \.github\/autopilot\.json: `stack` .*Run `autopilot init` again/);
});
