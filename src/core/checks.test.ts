import { test } from "node:test";
import assert from "node:assert/strict";
import { HIDDEN_OUTPUT, hideOutput, planChecks, redact, withBaseline, type CheckResult } from "./checks.ts";
import type { ContainerResult } from "./docker.ts";

test("each required check gets a command, a built-in scanner, or nothing", () => {
  assert.deepEqual(planChecks(["lint", "sast", "deps-scan", "secrets-scan", "types"], { lint: "npm run lint", sast: "make sast" }), [
    { check: "lint", kind: "command", command: "npm run lint" },
    { check: "sast", kind: "command", command: "make sast" },
    { check: "deps-scan", kind: "scanner", scanner: "deps-scan" },
    { check: "secrets-scan", kind: "scanner", scanner: "secrets-scan" },
    { check: "types", kind: "missing" },
  ]);
});

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

const failed: CheckResult = { check: "lint", state: "failure", description: "failed (exit 1)", output: "a.ts\n  1:1  error  bad  rule" };
const baselineCases: { name: string; run: ContainerResult; known: string[] | undefined; state: CheckResult["state"] }[] = [
  { name: "no baseline", run: { exit: 1, timedOut: false, output: failed.output, truncated: false }, known: undefined, state: "failure" },
  { name: "only known errors", run: { exit: 1, timedOut: false, output: failed.output, truncated: false }, known: ["a.ts", "#:# error bad rule"], state: "success" },
  { name: "a new error", run: { exit: 1, timedOut: false, output: `${failed.output}\n  2:2  error  worse  rule`, truncated: false }, known: ["a.ts", "#:# error bad rule"], state: "failure" },
  { name: "cut output", run: { exit: 1, timedOut: false, output: failed.output, truncated: true }, known: ["a.ts", "#:# error bad rule"], state: "failure" },
];

for (const { name, run, known, state } of baselineCases) {
  test(`baseline: ${name}`, () => {
    assert.equal(withBaseline(failed, run, known).state, state);
  });
}
