import { test } from "node:test";
import assert from "node:assert/strict";
import { onboardingBody, onboardingPrompt, ownPull, parseOnboardingResult, type Onboarding, type PullListing } from "./onboarding.ts";

const base: Onboarding = {
  repo: "acme/app",
  manager: "pnpm",
  generated: [".github/autopilot.json", ".devcontainer/devcontainer.json"],
  agent: { kind: "skipped", reason: "--no-agent" },
  validate: { kind: "ran", results: [{ check: "lint", outcome: "baseline", lines: 3 }, { check: "test", outcome: "passed" }] },
  host: { kind: "none" },
  readiness: [
    { section: "Environment", item: "A lockfile is committed.", ok: "yes" },
    { section: "Documentation", item: "`AGENTS.md` or `CLAUDE.md` exists.", ok: "no" },
    { section: "Delivery", item: "Rollback steps are written in the repo.", ok: "by hand" },
  ],
};

test("the body lists what was generated, what to curate, and the failing readiness items", () => {
  const body = onboardingBody(base);
  assert.match(body, /- `\.github\/autopilot\.json`\n- `\.devcontainer\/devcontainer\.json`\n/);
  assert.match(body, /- \[ \] Draft `AGENTS\.md`: the onboarding agent did not run \(--no-agent\)\./);
  assert.match(body, /- `lint`: fails on the default branch; 3 known error lines are in `\.github\/autopilot-baseline\.json`/);
  assert.match(body, /- `test`: passed/);
  assert.match(body, /- \[ \] Allow the repo on a host: `autopilot allow acme\/app`/);
  assert.match(body, /### Failing\n\n- \[ \] Documentation: `AGENTS\.md` or `CLAUDE\.md` exists\./);
  assert.match(body, /### To check by hand\n\n- \[ \] Delivery: Rollback steps are written in the repo\./);
  assert.doesNotMatch(body, /A lockfile is committed/);
});

const variants: { name: string; change: Partial<Onboarding>; expected: RegExp }[] = [
  {
    name: "agent notes are agent text",
    change: { agent: { kind: "ran", notes: ["Add a linter, then fixes #3 @someone"] } },
    expected: /- \[ \] Add a linter, then fi​xes #3 @​someone/,
  },
  { name: "a failing test", change: { validate: { kind: "ran", results: [{ check: "test", outcome: "failed" }] } }, expected: /- \[ \] `test` fails on the default branch/ },
  { name: "a lint run too long to compare", change: { validate: { kind: "ran", results: [{ check: "lint", outcome: "failed" }] } }, expected: /- \[ \] `lint` fails on the default branch/ },
  { name: "no docker", change: { validate: { kind: "skipped", reason: "Docker is not running" } }, expected: /- \[ \] Run the checks once: init could not \(Docker is not running\)\./ },
  { name: "the host allows the repo", change: { host: { kind: "allowed" } }, expected: /Check that the App is installed on the repo/ },
];

for (const { name, change, expected } of variants) {
  test(`body: ${name}`, () => {
    assert.match(onboardingBody({ ...base, ...change }), expected);
  });
}

test("the prompt names the detected commands and the check container limits", () => {
  const prompt = onboardingPrompt({ repo: "acme/app", manager: "pnpm", commands: { lint: "npm run lint" } });
  assert.match(prompt, /`lint`: `npm run lint`/);
  assert.match(prompt, /no network/);
  assert.match(prompt, /only npm/);
});

const results: { name: string; text: string; valid: boolean }[] = [
  { name: "a full result", text: '{"commands":{"lint":"npm run lint"},"agents_md":"# Agents","notes":[]}', valid: true },
  { name: "an unknown check", text: '{"commands":{"deploy":"x"},"agents_md":"# A","notes":[]}', valid: false },
  { name: "no AGENTS.md", text: '{"commands":{},"notes":[]}', valid: false },
];

for (const { name, text, valid } of results) {
  test(`onboarding result: ${name}`, () => {
    if (valid) assert.doesNotThrow(() => parseOnboardingResult(text));
    else assert.throws(() => parseOnboardingResult(text), /invalid/);
  });
}

const own: PullListing = { url: "https://github.com/acme/app/pull/3", isCrossRepository: false, headRepositoryOwner: { login: "acme" }, headRepository: { name: "app" } };
const pullCases: { name: string; pulls: PullListing[]; expected: string | undefined }[] = [
  { name: "the repo's own branch", pulls: [own], expected: own.url },
  { name: "another case", pulls: [{ ...own, headRepositoryOwner: { login: "Acme" } }], expected: own.url },
  { name: "a fork with the same branch name", pulls: [{ ...own, url: "fork", isCrossRepository: true, headRepositoryOwner: { login: "stranger" } }], expected: undefined },
  { name: "a fork flagged as cross-repository only", pulls: [{ ...own, url: "fork", isCrossRepository: true }], expected: undefined },
  { name: "a deleted head repository", pulls: [{ ...own, headRepository: null }], expected: undefined },
  { name: "the fork first, then the own one", pulls: [{ ...own, url: "fork", isCrossRepository: true }, own], expected: own.url },
];

for (const { name, pulls, expected } of pullCases) {
  test(`onboarding pull request: ${name}`, () => {
    assert.equal(ownPull(pulls, { owner: "acme", name: "app" }), expected);
  });
}
