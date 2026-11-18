import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RUN_DIR, shellEnvFile } from "../core/environment.ts";
import { devcontainerScript, HARNESSES } from "./harness.ts";

// What the repo's dev container could set, and what the host sets in the env file.
const REPO_ENV = { OPENCODE_CONFIG: "/repo/evil.json", OPENCODE_CONFIG_CONTENT: "repo", XDG_CONFIG_HOME: "/repo", HOME: "/repo", LANG: "C.UTF-8" };
const HOST_ENV = { OPENCODE_CONFIG_CONTENT: "host", HOME: "/root" };

const cases: { harness: keyof typeof HARNESSES; expected: Record<string, string | undefined> }[] = [
  { harness: "opencode", expected: { OPENCODE_CONFIG: undefined, XDG_CONFIG_HOME: undefined, OPENCODE_CONFIG_CONTENT: "host", HOME: "/root", LANG: "C.UTF-8" } },
  { harness: "claude", expected: { OPENCODE_CONFIG: "/repo/evil.json", XDG_CONFIG_HOME: "/repo", OPENCODE_CONFIG_CONTENT: "host", HOME: "/root", LANG: "C.UTF-8" } },
];

for (const { harness, expected } of cases) {
  test(`dev container env: ${harness} sees the host's values over the repo's`, () => {
    const runDir = mkdtempSync(join(tmpdir(), "autopilot-run-"));
    writeFileSync(join(runDir, "agent-env.sh"), shellEnvFile(HOST_ENV));
    writeFileSync(join(runDir, "prompt.md"), "");
    const script = devcontainerScript(HARNESSES[harness]).replaceAll(`${RUN_DIR}/`, `${runDir}/`);
    const out = execFileSync("sh", ["-c", script, "sh", runDir, "env"], { env: { PATH: process.env.PATH, ...REPO_ENV }, encoding: "utf8" });
    const seen = Object.fromEntries(out.trim().split("\n").map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]));
    for (const [name, value] of Object.entries(expected)) assert.equal(seen[name], value, name);
  });
}
