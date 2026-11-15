import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseConfig } from "./config.ts";

test("loads the sample config", () => {
  const config = parseConfig(readFileSync(new URL("../../examples/autopilot.json", import.meta.url), "utf8"), "sample");
  assert.equal(config.merge, "auto");
  assert.deepEqual(config.risk, { high_paths: ["src/auth/**"], max_diff_lines: 500 });
});

test("fills every default in a minimal config", () => {
  const config = parseConfig(`{ "version": 1, "stack": ["node"] }`, "minimal");
  assert.deepEqual(config, {
    version: 1,
    stack: ["node"],
    agents: {
      planner: { harness: "claude", model: "claude-opus-5-5", effort: "high" },
      builder: { harness: "claude", model: "claude-sonnet-5-5" },
    },
    steps: { spec: "planner", build: "builder", fix: "builder" },
    skills: { planner: [], builder: [] },
    verify: {
      mode: "local",
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
  assert.throws(() => parseConfig(`{ "version": 1, "stack": ["node"], "merge": "yolo" }`, "test"), /merge/);
});

test("rejects a secret value that is not an op:// reference", () => {
  assert.throws(() => parseConfig(`{ "version": 1, "stack": ["node"], "secrets": { "STRIPE_KEY": "sk_live_123" } }`, "test"), /secrets/);
});

test("rejects a config that is not JSON and names the source", () => {
  assert.throws(() => parseConfig(`{ "version": 1, }`, ".github/autopilot.json"), /Invalid config \.github\/autopilot\.json: /);
});
