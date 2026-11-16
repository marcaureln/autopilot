import { test } from "node:test";
import assert from "node:assert/strict";
import { knownFailureLines, newFailures, parseBaseline, renderBaseline } from "./baseline.ts";

const eslint = `
/work/src/a.ts
  12:5  error  'x' is assigned a value but never used  no-unused-vars
  40:1  error  Unexpected console statement  no-console

\u001b[31m✖ 2 problems (2 errors, 0 warnings)\u001b[39m
`;

test("known lines drop positions, summary lines, colors and blank lines", () => {
  assert.deepEqual(knownFailureLines(eslint), ["/work/src/a.ts", "#:# error 'x' is assigned a value but never used no-unused-vars", "#:# error Unexpected console statement no-console"]);
});

const lineCases: { output: string; expected: string[] }[] = [
  { output: "src/a2.ts(12,5): error TS2322: Type 'x'", expected: ["src/a2.ts(#,#): error TS2322: Type 'x'"] },
  { output: "src/a.ts:12:5 - error TS2345", expected: ["src/a.ts:#:# - error TS2345"] },
  { output: "src/a.ts:12 lint/rule-2 bad", expected: ["src/a.ts:# lint/rule-2 bad"] },
  { output: "Found 3 errors in 2 files.", expected: [] },
];

for (const { output, expected } of lineCases) {
  test(`known lines: ${output}`, () => {
    assert.deepEqual(knownFailureLines(output), expected);
  });
}

const tsc = "src/file1.ts(3,7): error TS2345: Argument of type 'string' is not assignable.\nFound 1 error in src/file1.ts:3\n";
const tscBaseline = knownFailureLines(tsc);

const tscCases: { name: string; output: string; expected: string[] }[] = [
  { name: "the same error moved to another line", output: tsc.replaceAll("3,7", "30,1").replace(":3", ":30"), expected: [] },
  {
    name: "the same rule in another file",
    output: tsc.replaceAll("file1", "file2"),
    expected: ["src/file2.ts(#,#): error TS2345: Argument of type 'string' is not assignable."],
  },
  { name: "another error code", output: tsc.replace("TS2345", "TS2322"), expected: ["src/file1.ts(#,#): error TS2322: Argument of type 'string' is not assignable."] },
  { name: "only the summary count changes", output: `${tsc}\nFound 2 errors in 1 file.\n`, expected: [] },
];

for (const { name, output, expected } of tscCases) {
  test(`new failures: ${name}`, () => {
    assert.deepEqual(newFailures(output, tscBaseline), expected);
  });
}

const baseline = knownFailureLines(eslint);

const cases: { name: string; output: string; expected: string[] }[] = [
  { name: "the same errors", output: eslint, expected: [] },
  { name: "the same errors on other lines", output: eslint.replace("12:5", "14:7").replace("40:1", "3:9"), expected: [] },
  { name: "fewer errors", output: eslint.replace(/ {2}40:1.*\n/, ""), expected: [] },
  {
    name: "a new error",
    output: eslint.replace("no-console\n", "no-console\n  50:2  error  'y' is not defined  no-undef\n"),
    expected: ["#:# error 'y' is not defined no-undef"],
  },
  {
    name: "a known error once more",
    output: eslint.replace("no-console\n", "no-console\n  60:1  error  Unexpected console statement  no-console\n"),
    expected: ["#:# error Unexpected console statement no-console"],
  },
  { name: "no output at all", output: "", expected: ["(the check failed with no output)"] },
  { name: "only a summary line", output: "✖ 2 problems (2 errors, 0 warnings)", expected: ["(the check failed with no output)"] },
];

for (const { name, output, expected } of cases) {
  test(`new failures: ${name}`, () => {
    assert.deepEqual(newFailures(output, baseline), expected);
  });
}

test("the baseline file round-trips", () => {
  const text = renderBaseline({ lint: ["a", "b"] });
  assert.deepEqual(parseBaseline(text), { lint: ["a", "b"] });
});

const invalid: { name: string; text: string }[] = [
  { name: "not JSON", text: "{" },
  { name: "no version", text: '{"checks":{}}' },
  { name: "lines that are not strings", text: '{"version":1,"checks":{"lint":[1]}}' },
];

for (const { name, text } of invalid) {
  test(`the baseline file is refused: ${name}`, () => {
    assert.throws(() => parseBaseline(text), /autopilot-baseline\.json/);
  });
}
