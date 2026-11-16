import { test } from "node:test";
import assert from "node:assert/strict";
import { HIDDEN_OUTPUT, hideOutput, nodeInstallCommand, planChecks, redact, type CheckResult } from "./checks.ts";

test("each required check gets a stack command, a built-in scanner, or nothing", () => {
  assert.deepEqual(planChecks(["lint", "sast", "deps-scan", "secrets-scan", "types"], { lint: "npm run lint", sast: "make sast" }), [
    { check: "lint", kind: "stack", command: "npm run lint" },
    { check: "sast", kind: "stack", command: "make sast" },
    { check: "deps-scan", kind: "scanner", scanner: "deps-scan" },
    { check: "secrets-scan", kind: "scanner", scanner: "secrets-scan" },
    { check: "types", kind: "missing" },
  ]);
});

const installCases: { files: string[]; expected: string | undefined }[] = [
  { files: ["package.json", "package-lock.json"], expected: "npm ci" },
  { files: ["package.json", "pnpm-lock.yaml"], expected: "npm install --global pnpm && pnpm install --frozen-lockfile" },
  { files: ["package.json", "yarn.lock"], expected: "npm install --global yarn && yarn install --frozen-lockfile" },
  { files: ["package.json"], expected: "npm install" },
  { files: ["README.md"], expected: undefined },
];

for (const { files, expected } of installCases) {
  test(`install for [${files.join(", ")}]`, () => {
    assert.equal(nodeInstallCommand((file) => files.includes(file)), expected);
  });
}

const redactCases: { name: string; text: string; values: string[]; expected: string }[] = [
  { name: "no secret", text: "ok", values: [], expected: "ok" },
  { name: "one value, twice", text: "key=abc123 and abc123", values: ["abc123"], expected: "key=*** and ***" },
  { name: "the longer value first", text: "abc123456", values: ["abc", "abc123456"], expected: "***" },
  { name: "a value with regex characters", text: "pa$$.w*rd!", values: ["pa$$.w*rd"], expected: "***!" },
  { name: "an empty value", text: "text", values: [""], expected: "text" },
];

for (const { name, text, values, expected } of redactCases) {
  test(`redact: ${name}`, () => {
    assert.equal(redact(text, values), expected);
  });
}

const hideCases: { name: string; result: CheckResult; expected: CheckResult }[] = [
  { name: "a pass", result: { check: "test", state: "success", description: "passed", output: "ok KEY=abc" }, expected: { check: "test", state: "success", description: "passed", output: "" } },
  {
    name: "a failure",
    result: { check: "test", state: "failure", description: "failed (exit 3)", output: "YWJj" },
    expected: { check: "test", state: "failure", description: "failed", output: HIDDEN_OUTPUT },
  },
  { name: "a time-out", result: { check: "test", state: "error", description: "timed out", output: "616263" }, expected: { check: "test", state: "error", description: "error", output: HIDDEN_OUTPUT } },
];

for (const { name, result, expected } of hideCases) {
  test(`a check with secrets shows only pass or fail: ${name}`, () => {
    assert.deepEqual(hideOutput(result), expected);
  });
}
