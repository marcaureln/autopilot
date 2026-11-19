import { test } from "node:test";
import assert from "node:assert/strict";
import type { Config } from "./config.ts";
import { checkCommandsVerdict, ciJobsVerdict, diskVerdict, fail, formatResult, labelsVerdict, memoryBytes, memoryVerdict, missingCiJobs, ok, quotaVerdict, releaseVerdict, runDoctor, skipped, warn, workflowJobNames, workflowSecretsVerdict, type Check, type Verdict } from "./doctor.ts";
import { LABELS } from "./state.ts";

const GIB = 1024 ** 3;

const formatCases: { name: string; verdict: Verdict; expected: string[] }[] = [
  { name: "ok", verdict: ok(), expected: ["OK    git"] },
  { name: "ok with a note", verdict: ok("v1.2.3"), expected: ["OK    git: v1.2.3"] },
  { name: "skipped", verdict: skipped("no SSH"), expected: ["OK    git: skipped, no SSH"] },
  { name: "warn", verdict: warn("a problem", "a command"), expected: ["WARN  git", "      a problem", "      fix: a command"] },
  { name: "fail with two lines", verdict: fail("one\ntwo", "a command"), expected: ["FAIL  git", "      one", "      two", "      fix: a command"] },
];

for (const { name, verdict, expected } of formatCases) {
  test(`doctor output: ${name}`, () => {
    assert.deepEqual(formatResult("git", verdict), expected);
  });
}

const check = (name: string, verdict: Verdict): Check => ({ name, run: async () => verdict });

const runCases: { name: string; checks: Check[]; failed: number; lines: string[] }[] = [
  { name: "no check", checks: [], failed: 0, lines: [] },
  { name: "ok and warn pass", checks: [check("a", ok()), check("b", warn("p", "f"))], failed: 0, lines: ["OK    a", "WARN  b", "      p", "      fix: f"] },
  { name: "each fail counts", checks: [check("a", fail("p", "f")), check("b", ok()), check("c", fail("q", "g"))], failed: 2, lines: ["FAIL  a", "      p", "      fix: f", "OK    b", "FAIL  c", "      q", "      fix: g"] },
  {
    name: "a check that throws fails and the next one still runs",
    checks: [{ name: "a", run: () => Promise.reject(new Error("boom")) }, check("b", ok())],
    failed: 1,
    lines: ["FAIL  a", "      boom", "      fix: fix the cause above, then run autopilot doctor again", "OK    b"],
  },
];

for (const { name, checks, failed, lines } of runCases) {
  test(`doctor run: ${name}`, async () => {
    const printed: string[] = [];
    assert.equal(await runDoctor(checks, (line) => printed.push(line)), failed);
    assert.deepEqual(printed, lines);
  });
}

test("memory sizes use Docker's units", () => {
  assert.equal(memoryBytes("6g"), 6 * GIB);
  assert.equal(memoryBytes("512m"), 512 * 1024 ** 2);
  assert.equal(memoryBytes("100k"), 100 * 1024);
  assert.throws(() => memoryBytes("6"), /not a memory size/);
  assert.throws(() => memoryBytes("6G"), /not a memory size/);
});

const memoryCases: { name: string; total: number; limit: string; concurrency: number; status: Verdict["status"] }[] = [
  { name: "fits", total: 8 * GIB, limit: "6g", concurrency: 1, status: "ok" },
  { name: "fits exactly", total: 12 * GIB, limit: "6g", concurrency: 2, status: "ok" },
  { name: "concurrency does not fit", total: 8 * GIB, limit: "6g", concurrency: 2, status: "fail" },
  { name: "small unit", total: GIB, limit: "512m", concurrency: 2, status: "ok" },
];

for (const { name, total, limit, concurrency, status } of memoryCases) {
  test(`memory verdict: ${name}`, () => {
    assert.equal(memoryVerdict(total, limit, concurrency, "/etc/autopilot/host.json").status, status);
  });
}

test("disk verdict asks for 20 GiB", () => {
  assert.equal(diskVerdict(20 * GIB).status, "ok");
  assert.equal(diskVerdict(20 * GIB - 1).status, "fail");
});

const releaseCases: { name: string; client: string | undefined; host: string; expected: Verdict }[] = [
  { name: "same release", client: "v1.2.0", host: "v1.2.0", expected: ok("v1.2.0") },
  { name: "client from a checkout", client: undefined, host: "v1.2.0", expected: ok("the host runs v1.2.0, this client runs from a checkout") },
  { name: "host from a checkout", client: "v1.2.0", host: "0123456789ab", expected: ok("the host runs the checkout build 0123456789ab") },
  { name: "older client", client: "v1.2.0", host: "v1.10.0", expected: fail("this client is v1.2.0, the host runs v1.10.0", "autopilot self-update --version v1.10.0") },
  { name: "older host", client: "v1.10.0", host: "v1.2.0", expected: fail("this client is v1.10.0, the host runs v1.2.0", "autopilot update --host pi --version v1.10.0") },
];

for (const { name, client, host, expected } of releaseCases) {
  test(`release verdict: ${name}`, () => {
    assert.deepEqual(releaseVerdict(client, host, "pi"), expected);
  });
}

const quota = (remaining: number, limit = 5000) => ({ limit, remaining, resetAt: new Date("2026-01-01T01:00:00Z") });

test("rate limit verdict looks at core and search", () => {
  assert.equal(quotaVerdict({ core: quota(5000), search: quota(30, 30) }).status, "ok");
  assert.equal(quotaVerdict({ core: quota(499), search: quota(5000) }).status, "fail");
  assert.deepEqual(quotaVerdict({ core: quota(5000), search: quota(2, 30) }), fail("the search quota has 2 of 30 calls left until 2026-01-01T01:00:00.000Z", "wait for the reset (the host polls again by itself), or stop the host until then with autopilot stop"));
});

test("labels verdict names the missing labels and the commands that create them", () => {
  assert.deepEqual(labelsVerdict(LABELS.map((label) => label.name), "o/r"), ok());
  const verdict = labelsVerdict(["autopilot", "bug"], "o/r");
  assert.equal(verdict.status, "warn");
  assert.ok(verdict.status === "warn" && verdict.problem.startsWith("missing labels: autopilot:working"));
  assert.ok(verdict.status === "warn" && verdict.fix.startsWith('gh label create autopilot:working --repo o/r --color '));
});

const workflowCases: { name: string; text: string; expected: string[] }[] = [
  { name: "job ids", text: "name: ci\non: push\njobs:\n  check:\n    runs-on: x\n    steps:\n      - run: y\n  lint:\n    runs-on: x\n", expected: ["check", "lint"] },
  { name: "a name replaces the id", text: "jobs:\n  check:\n    name: Types and tests\n    runs-on: x\n  lint:\n    runs-on: x\n", expected: ["Types and tests", "lint"] },
  { name: "quoted name and a comment", text: "jobs:\n  a:\n    name: 'Quoted: name' # note\n  b:\n    name: Plain # note\n", expected: ["Quoted: name", "Plain"] },
  { name: "a step name is not a job name", text: "jobs:\n  check:\n    runs-on: x\n    steps:\n      - name: Install\n        run: y\n", expected: ["check"] },
  { name: "four-space indent", text: "jobs:\n    check:\n        name: Check\n    lint:\n        runs-on: x\n", expected: ["Check", "lint"] },
  { name: "keys after jobs", text: "jobs:\n  check:\n    runs-on: x\nenv:\n  other:\n    name: no\n", expected: ["check"] },
  { name: "comments and blank lines", text: "# c\njobs:\n\n  # c\n  check:\n    runs-on: x\n", expected: ["check"] },
  { name: "no jobs", text: "name: nothing\non: push\n", expected: [] },
];

for (const { name, text, expected } of workflowCases) {
  test(`workflow jobs: ${name}`, () => {
    assert.deepEqual(workflowJobNames(text), expected);
  });
}

test("a required check names a job, or a matrix job of that name", () => {
  assert.deepEqual(missingCiJobs(["check", "test (18)", "e2e"], ["check", "test"]), ["e2e"]);
  assert.deepEqual(missingCiJobs(["tests"], ["test"]), ["tests"]);
  assert.deepEqual(missingCiJobs([], []), []);
});

function config(verify: Partial<Config["verify"]>): Config {
  return { verify: { mode: "host", required: [], commands: {}, timeout_minutes: 10, ...verify } } as Config;
}

const configCases: { name: string; verdict: Verdict; status: Verdict["status"] }[] = [
  { name: "host mode with a command for each check", verdict: checkCommandsVerdict(config({ required: ["lint", "sast"], commands: { lint: "npm run lint" } })), status: "ok" },
  { name: "host mode with a check that has no command", verdict: checkCommandsVerdict(config({ required: ["lint", "types"], commands: { lint: "npm run lint" } })), status: "fail" },
  { name: "ci mode needs no command", verdict: checkCommandsVerdict(config({ mode: "ci", required: ["lint"] })), status: "ok" },
  { name: "ci mode with the jobs", verdict: ciJobsVerdict(config({ mode: "ci", required: ["check"] }), ["check"]), status: "ok" },
  { name: "ci mode with a missing job", verdict: ciJobsVerdict(config({ mode: "ci", required: ["check", "e2e"] }), ["check"]), status: "fail" },
  { name: "host mode needs no job", verdict: ciJobsVerdict(config({ required: ["lint"] }), []), status: "ok" },
];

for (const { name, verdict, status } of configCases) {
  test(`config verdict: ${name}`, () => {
    assert.equal(verdict.status, status);
  });
}

const secretsCases: { name: string; canChange: boolean; secrets: number | undefined; status: Verdict["status"] }[] = [
  { name: "the App cannot change workflows", canChange: false, secrets: 5, status: "ok" },
  { name: "the App can, the repo has no secret", canChange: true, secrets: 0, status: "ok" },
  { name: "the App can, the secrets are unknown", canChange: true, secrets: undefined, status: "ok" },
  { name: "the App can, the repo has secrets", canChange: true, secrets: 2, status: "warn" },
];

for (const { name, canChange, secrets, status } of secretsCases) {
  test(`workflow secrets verdict: ${name}`, () => {
    assert.equal(workflowSecretsVerdict(canChange, secrets).status, status);
  });
}
