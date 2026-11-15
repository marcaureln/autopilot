import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "./config.ts";

function writeConfig(content: string): string {
  const path = join(mkdtempSync(join(tmpdir(), "autopilot-")), "autopilot.json");
  writeFileSync(path, content);
  return path;
}

test("loads the sample config", () => {
  const config = loadConfig(new URL("../../examples/autopilot.json", import.meta.url).pathname);
  assert.equal(config.merge, "auto");
  assert.deepEqual(config.risk, { high_paths: ["src/auth/**"], max_diff_lines: 500 });
});

test("fills every default in a minimal config", () => {
  const config = loadConfig(writeConfig(`{ "version": 1, "stack": ["node"] }`));
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
  const path = writeConfig(`{ "version": 1, "stack": ["node"], "merge": "yolo" }`);
  assert.throws(() => loadConfig(path), /merge/);
});

test("rejects a secret value that is not an op:// reference", () => {
  const path = writeConfig(`{ "version": 1, "stack": ["node"], "secrets": { "STRIPE_KEY": "sk_live_123" } }`);
  assert.throws(() => loadConfig(path), /secrets/);
});
