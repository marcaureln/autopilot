import { test } from "node:test";
import assert from "node:assert/strict";
import {
  devcontainerFiles,
  onboardingBody,
  onboardingPrompt,
  ownPull,
  parseOnboardingResult,
  readiness,
  renderConfig,
  type Onboarding,
  type OnboardingResult,
  type PullListing,
  type RepoFiles,
} from "./onboarding.ts";

const base: Onboarding = {
  repo: "acme/app",
  merge: "manual",
  generated: [".github/autopilot.json", ".devcontainer/devcontainer.json"],
  notes: [],
  environment: { existing: false, image: "node:26.13.1", services: ["postgres"], install: "npm ci", reason: "The app reads Postgres in src/db.ts." },
  validate: { kind: "ran", results: [{ check: "lint", outcome: "baseline", lines: 3 }, { check: "test", outcome: "passed" }] },
  host: { kind: "none" },
  readiness: [
    { section: "Environment", item: "A lockfile is committed.", ok: "yes" },
    { section: "Documentation", item: "`AGENTS.md` or `CLAUDE.md` exists.", ok: "no" },
    { section: "Delivery", item: "Rollback steps are written in the repo.", ok: "by hand" },
  ],
};

test("the body lists what was generated, the environment, what to curate, and the failing readiness items", () => {
  const body = onboardingBody(base);
  assert.match(body, /- `\.github\/autopilot\.json`\n- `\.devcontainer\/devcontainer\.json`\n/);
  assert.match(body, /## Environment\n\n- Image: `node:26\.13\.1`\n- Services: `postgres`\n- Install: `npm ci`\n- Why: The app reads Postgres in src\/db\.ts\.\n/);
  assert.match(body, /- `lint`: fails on the default branch; 3 known error lines are in `\.github\/autopilot-baseline\.json`/);
  assert.match(body, /- `test`: passed/);
  assert.match(body, /- \[ \] Read `\.devcontainer\/`: the onboarding agent wrote it\./);
  assert.match(body, /- \[ \] Let a host watch the repo: `autopilot watch acme\/app` on the default host, or add `--host <name>`\./);
  assert.match(body, /### Failing\n\n- \[ \] Documentation: `AGENTS\.md` or `CLAUDE\.md` exists\./);
  assert.match(body, /### To check by hand\n\n- \[ \] Delivery: Rollback steps are written in the repo\./);
  assert.doesNotMatch(body, /A lockfile is committed/);
});

const variants: { name: string; change: Partial<Onboarding>; expected: RegExp }[] = [
  {
    name: "agent notes are agent text",
    change: { notes: ["Add a linter, then fixes #3 @someone"] },
    expected: /- \[ \] Add a linter, then fi\u200bxes #3 @\u200bsomeone/,
  },
  {
    name: "the environment description is agent text",
    change: { environment: { ...base.environment, reason: "closes #4" } },
    expected: /- Why: cl\u200boses #4/,
  },
  { name: "no services", change: { environment: { ...base.environment, services: [] } }, expected: /- Services: none/ },
  { name: "an existing .devcontainer", change: { environment: { ...base.environment, existing: true } }, expected: /`\.devcontainer\/` was already in the repo: init kept it\./ },
  { name: "a failing test", change: { validate: { kind: "ran", results: [{ check: "test", outcome: "failed" }] } }, expected: /- \[ \] `test` fails on the default branch/ },
  { name: "a failing install", change: { validate: { kind: "ran", results: [{ check: "install", outcome: "failed" }] } }, expected: /- \[ \] `install` fails on the default branch/ },
  {
    name: "a refused dev container",
    change: { validate: { kind: "refused", problems: ["devcontainer.json: `runArgs` passes raw arguments to docker run"] } },
    expected: /- not run: the guardrails refuse `\.devcontainer\/`\n  - devcontainer\.json: `runArgs`/,
  },
  { name: "the host watches the repo", change: { host: { kind: "watched" } }, expected: /Check that the App is installed on the repo/ },
  { name: "the host opened it for an issue", change: { host: { kind: "issue", issue: 4 } }, expected: /autopilot opened it for #4\. The work on that issue starts when this pull request is merged\./ },
  { name: "a manual merge", change: {}, expected: /`merge` is `manual`/ },
  { name: "an existing auto merge", change: { merge: "auto" }, expected: /`merge` is `auto`/ },
];

for (const { name, change, expected } of variants) {
  test(`body: ${name}`, () => {
    assert.match(onboardingBody({ ...base, ...change }), expected);
  });
}

const promptCases: { name: string; input: Parameters<typeof onboardingPrompt>[0]; match: RegExp[]; noMatch: RegExp[] }[] = [
  {
    name: "a repo with no dev container",
    input: { repo: "acme/app", hasDevcontainer: false, claudeCodeVersion: "2.1.325", notes: undefined, request: undefined },
    match: [/CLAUDE_CODE_VERSION.*2\.1\.325/, /no network/, /`devcontainer_files`/, /without its firewall/],
    noMatch: [/# Notes from the owner/, /already has `\.devcontainer\/`/],
  },
  {
    name: "a repo with a dev container and notes",
    input: { repo: "acme/app", hasDevcontainer: true, claudeCodeVersion: "2.1.325", notes: "Use Postgres 18.\n", request: undefined },
    match: [/already has `\.devcontainer\/`/, /# Notes from the owner\n\nUse Postgres 18\./],
    noMatch: [/CLAUDE_CODE_VERSION/],
  },
  {
    name: "a blank repo onboarded for an issue",
    input: {
      repo: "acme/game",
      hasDevcontainer: false,
      claudeCodeVersion: "2.1.325",
      notes: undefined,
      request: { issue: { number: 4, title: "A 2D platformer in Godot 4", body: "Levels and a player." }, thread: [{ id: 1, nodeId: "n1", author: "owner", body: "Use GDScript.", createdAt: "2026-01-01T00:00:00Z" }] },
    },
    match: [/# The request/, /Do not do the work of the issue/, /## Issue #4: A 2D platformer in Godot 4\n\nLevels and a player\./, /\*\*@owner\*\* \(2026-01-01T00:00:00Z\):\n\nUse GDScript\./],
    noMatch: [/# Notes from the owner/],
  },
];

for (const { name, input, match, noMatch } of promptCases) {
  test(`prompt: ${name}`, () => {
    const prompt = onboardingPrompt(input);
    for (const pattern of match) assert.match(prompt, pattern);
    for (const pattern of noMatch) assert.doesNotMatch(prompt, pattern);
  });
}

const environment = '"environment":{"image":"node:26.13.1","services":[],"install":"npm ci","reason":"Node app."}';
const results: { name: string; text: string; valid: boolean }[] = [
  { name: "a full result", text: `{"commands":{"lint":"npm run lint"},"agents_md":"# Agents","notes":[],${environment}}`, valid: true },
  { name: "with dev container files", text: `{"commands":{},"agents_md":"# A","notes":[],${environment},"devcontainer_files":{"devcontainer.json":"{}","Dockerfile":"FROM x"}}`, valid: true },
  { name: "an unknown check", text: `{"commands":{"deploy":"x"},"agents_md":"# A","notes":[],${environment}}`, valid: false },
  { name: "no AGENTS.md", text: `{"commands":{},"notes":[],${environment}}`, valid: false },
  { name: "no environment", text: '{"commands":{},"agents_md":"# A","notes":[]}', valid: false },
  { name: "a dev container file in a folder", text: `{"commands":{},"agents_md":"# A","notes":[],${environment},"devcontainer_files":{"../x":"y"}}`, valid: false },
  { name: "a hidden dev container file", text: `{"commands":{},"agents_md":"# A","notes":[],${environment},"devcontainer_files":{".env":"y"}}`, valid: false },
];

for (const { name, text, valid } of results) {
  test(`onboarding result: ${name}`, () => {
    if (valid) assert.doesNotThrow(() => parseOnboardingResult(text));
    else assert.throws(() => parseOnboardingResult(text), /invalid/);
  });
}

const result = parseOnboardingResult(`{"commands":{},"agents_md":"# A","notes":[],${environment},"devcontainer_files":{"devcontainer.json":"{}","compose.yaml":"services: {}"}}`);
const filesCases: { name: string; hasDevcontainer: boolean; result: OnboardingResult; expected: Record<string, string> | RegExp }[] = [
  { name: "new files go under .devcontainer/", hasDevcontainer: false, result, expected: { ".devcontainer/devcontainer.json": "{}\n", ".devcontainer/compose.yaml": "services: {}\n" } },
  { name: "an existing .devcontainer/ is kept", hasDevcontainer: true, result, expected: {} },
  { name: "no devcontainer.json for a repo that needs one", hasDevcontainer: false, result: { ...result, devcontainer_files: { Dockerfile: "FROM x" } }, expected: /devcontainer\.json/ },
  { name: "the files of the host are not the agent's to write", hasDevcontainer: false, result: { ...result, devcontainer_files: { "devcontainer.json": "{}", "autopilot.compose.json": "{}" } }, expected: /autopilot\.compose\.json/ },
];

for (const { name, hasDevcontainer, result: input, expected } of filesCases) {
  test(`dev container files: ${name}`, () => {
    if (expected instanceof RegExp) assert.throws(() => devcontainerFiles(input, hasDevcontainer), expected);
    else assert.deepEqual(devcontainerFiles(input, hasDevcontainer), expected);
  });
}

test("config: a new repo gets the checks of the agent, the scanners, the skills and a manual merge", () => {
  const config = JSON.parse(renderConfig(undefined, { lint: "npm run lint", test: "npm test" }, ["github.com/example-org/skills//tdd#main"]));
  assert.deepEqual(config.verify, { required: ["lint", "test", "sast", "deps-scan", "secrets-scan"], commands: { lint: "npm run lint", test: "npm test" } });
  assert.deepEqual(config.skills, { planner: ["github.com/example-org/skills//tdd#main"], builder: ["github.com/example-org/skills//tdd#main"] });
  assert.equal(config.merge, "manual");
  assert.equal(config.stack, undefined);
});

test("config: no skill list stays empty", () => {
  const existing = { version: 1, skills: { builder: ["/etc/autopilot/skills/a"] }, verify: { required: [], commands: {} } };
  assert.deepEqual(JSON.parse(renderConfig(JSON.stringify(existing), {}, [])).skills, { builder: ["/etc/autopilot/skills/a"] });
});

test("config: an existing config keeps its fields, commands and skills, drops `stack`, and gains the missing checks", () => {
  const existing = {
    version: 1,
    stack: ["node"],
    merge: "auto",
    skills: { builder: ["/etc/autopilot/skills/a"] },
    verify: { required: ["lint", "sast"], commands: { lint: "test -s README.md" } },
    secrets: { A: "op://autopilot/o_r/A" },
  };
  const config = JSON.parse(renderConfig(JSON.stringify(existing), { lint: "npm run lint", test: "npm test" }, ["/etc/autopilot/skills/a", "/etc/autopilot/skills/b"]));
  assert.equal(config.merge, "auto");
  assert.equal(config.stack, undefined);
  assert.deepEqual(config.secrets, existing.secrets);
  assert.deepEqual(config.skills, { planner: ["/etc/autopilot/skills/a", "/etc/autopilot/skills/b"], builder: ["/etc/autopilot/skills/a", "/etc/autopilot/skills/b"] });
  assert.deepEqual(config.verify, { required: ["lint", "sast", "test", "deps-scan", "secrets-scan"], commands: { lint: "test -s README.md", test: "npm test" } });
});

function files(entries: Record<string, string>): RepoFiles {
  return { read: (path) => entries[path] };
}

const readinessCases: { name: string; entries: Record<string, string>; commands: Record<string, string>; failing: string[] }[] = [
  {
    name: "a ready repo",
    entries: { "uv.lock": "", "AGENTS.md": "", ".env.example": "", ".gitignore": ".venv\n.env\n", ".github/workflows/ci.yml": "" },
    commands: { lint: "x", types: "x", test: "x" },
    failing: [],
  },
  {
    name: "a bare repo",
    entries: { "main.go": "", ".env": "A=1" },
    commands: { test: "go test ./..." },
    failing: [
      "A lockfile is committed.",
      "`verify.commands` has `lint`, `types` and `test`.",
      "CI runs the checks (a workflow in `.github/workflows/`).",
      "A `.env.example` lists every key the app reads.",
      "`AGENTS.md` or `CLAUDE.md` exists.",
      "No `.env` file is tracked in git.",
      "`.gitignore` ignores `.env`.",
    ],
  },
];

for (const { name, entries, commands, failing } of readinessCases) {
  test(`readiness: ${name}`, () => {
    const items = readiness(files(entries), Object.keys(entries), commands);
    assert.deepEqual(
      items.filter((item) => item.ok === "no").map((item) => item.item),
      failing,
    );
    assert.ok(items.some((item) => item.ok === "by hand"), "some items need a person");
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
