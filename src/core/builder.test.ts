import { test } from "node:test";
import assert from "node:assert/strict";
import { botIdentity, builderPrompt, commitProblems, neutralize, parseBuilderResult, pullBody, workflowStop, type Commit } from "./builder.ts";
import { workflowFiles } from "./risk.ts";

const bot = botIdentity("autopilot[bot]", 123456);

test("the bot identity uses the noreply address GitHub links to the bot account", () => {
  assert.deepEqual(bot, { name: "autopilot[bot]", email: "123456+autopilot[bot]@users.noreply.github.com" });
});

function commit(overrides: Partial<Commit> = {}): Commit {
  return { sha: "abcdef1234", parents: ["0000000"], author: bot, committer: bot, message: "docs: add CONTRIBUTING.md\n", ...overrides };
}

const someone = { name: "Someone", email: "someone@example.com" };

const commitCases: { name: string; commits: Commit[]; expected: string[] }[] = [
  { name: "one clean commit", commits: [commit()], expected: [] },
  { name: "no commit", commits: [], expected: ["the builder made no commit"] },
  { name: "too many commits", commits: Array.from({ length: 51 }, () => commit()), expected: ["the builder made 51 commits, more than 50"] },
  { name: "another author", commits: [commit({ author: someone })], expected: ["abcdef1 has the author Someone <someone@example.com>"] },
  { name: "another committer", commits: [commit({ committer: someone })], expected: ["abcdef1 has the committer Someone <someone@example.com>"] },
  { name: "a merge commit", commits: [commit({ parents: ["a", "b"] })], expected: ["abcdef1 is a merge commit or has no parent"] },
  { name: "a co-author trailer", commits: [commit({ message: "feat: x\n\nCo-Authored-By: Claude <noreply@anthropic.com>\n" })], expected: ["abcdef1 has an attribution line in its message"] },
  { name: "a generated-with line", commits: [commit({ message: "feat: x\n\nGenerated with Claude Code\n" })], expected: ["abcdef1 has an attribution line in its message"] },
];

for (const { name, commits, expected } of commitCases) {
  test(`commits: ${name}`, () => {
    assert.deepEqual(commitProblems(commits, bot), expected);
  });
}

const neutralizeCases: { text: string; expected: string }[] = [
  { text: "Fixes #3 and closes #4", expected: "Fi\u200bxes #3 and cl\u200boses #4" },
  { text: "Fix #3, fix: owner/repo#7", expected: "Fi\u200bx #3, fi\u200bx: owner/repo#7" },
  { text: "Resolved https://github.com/o/r/issues/5", expected: "Re\u200bsolved https://github.com/o/r/issues/5" },
  { text: "Thanks @owner", expected: "Thanks @\u200bowner" },
  { text: "Adds a fixture and a closet", expected: "Adds a fixture and a closet" },
];

for (const { text, expected } of neutralizeCases) {
  test(`neutralize "${text}"`, () => {
    assert.equal(neutralize(text), expected);
  });
}

const workflowCases: { name: string; paths: string[]; expected: string[] }[] = [
  { name: "no workflow file", paths: ["src/a.ts", ".github/autopilot.json", "docs/.github/workflows/x.yml"], expected: [] },
  { name: "a workflow file", paths: ["src/a.ts", ".github/workflows/check.yml"], expected: [".github/workflows/check.yml"] },
  { name: "a file in a subfolder of workflows", paths: [".github/workflows/scripts/run.sh"], expected: [".github/workflows/scripts/run.sh"] },
  { name: "both sides of a rename out of workflows", paths: [".github/workflows/ci.yml", "ci.yml"], expected: [".github/workflows/ci.yml"] },
  { name: "the same file in two commits", paths: [".github/workflows/ci.yml", "", ".github/workflows/ci.yml"], expected: [".github/workflows/ci.yml"] },
];

for (const { name, paths, expected } of workflowCases) {
  test(`workflow files: ${name}`, () => {
    assert.deepEqual(workflowFiles(paths), expected);
  });
}

const CI = ".github/workflows/ci.yml";
const DEPLOY = ".github/workflows/deploy.yml";

const stopCases: { name: string; paths: string[]; workflows: boolean; planned: string[]; expected: RegExp | undefined }[] = [
  { name: "a workflow change without the permission", paths: [CI], workflows: false, planned: [CI], expected: /`\.github\/workflows\/ci\.yml`.*make this change yourself, or give the App the Workflows permission \(Read and write\)/ },
  { name: "no workflow change without the permission", paths: ["src/a.ts"], workflows: false, planned: [], expected: undefined },
  { name: "a planned workflow change with the permission", paths: [CI, "src/a.ts"], workflows: true, planned: [CI], expected: undefined },
  { name: "no workflow change with the permission", paths: ["src/a.ts"], workflows: true, planned: [], expected: undefined },
  { name: "an unplanned workflow change with the permission", paths: [CI], workflows: true, planned: ["src/a.ts"], expected: /^the change touches `\.github\/workflows\/ci\.yml`, which the approved plan does not list\. Add it to the plan and approve it again, or make this change yourself\.$/ },
  { name: "only the unplanned workflow is named", paths: [CI, DEPLOY], workflows: true, planned: [CI], expected: /^the change touches `\.github\/workflows\/deploy\.yml`, which/ },
  { name: "several unplanned workflows", paths: [CI, DEPLOY], workflows: true, planned: [], expected: /`\.github\/workflows\/ci\.yml`, `\.github\/workflows\/deploy\.yml`, which the approved plan does not list\. Add them to the plan/ },
];

for (const { name, paths, workflows, planned, expected } of stopCases) {
  test(`workflow stop: ${name}`, () => {
    const stop = workflowStop(paths, workflows, planned);
    if (expected) assert.match(stop ?? "", expected);
    else assert.equal(stop, undefined);
  });
}

const builderRuleCases: { workflows: boolean; forbids: boolean }[] = [
  { workflows: false, forbids: true },
  { workflows: true, forbids: false },
];

for (const { workflows, forbids } of builderRuleCases) {
  test(`the builder prompt ${forbids ? "forbids" : "allows"} workflow changes when the permission is ${workflows ? "there" : "missing"}`, () => {
    const prompt = builderPrompt({ repo: "o/r", workdir: "/workspaces/r", issue: { number: 7, title: "t", body: "" }, thread: [], secrets: [], canChangeWorkflows: workflows });
    assert.equal(prompt.includes("Do not add, change, delete or rename files under `.github/workflows/`"), forbids);
    assert.match(prompt, /- Keep the change to what the spec asks\.\n(- .*\n)?\n# Environment/);
  });
}

test("the pull request body links the issue first and drops attribution lines from the summary", () => {
  assert.equal(pullBody(7, "Adds CONTRIBUTING.md.\n🤖 Generated with Claude Code\nFixes #8"), "Fixes #7\n\nAdds CONTRIBUTING.md.\nFi\u200bxes #8\n");
});

test("the pull request body copies the For a person section, cleaned like the summary", () => {
  assert.equal(
    pullBody(7, "Adds a test.", "Add a lint job to `.github/workflows/ci.yml`.\nCo-Authored-By: someone <a@b.c>\nThis closes the gap."),
    "Fixes #7\n\nAdds a test.\n\n## For a person\n\nAdd a lint job to `.github/workflows/ci.yml`.\nThis cl\u200boses the gap.\n",
  );
});

test("a fix prompt carries the failed check output, cut to its end", () => {
  const prompt = builderPrompt({
    repo: "o/r",
    workdir: "/workspaces/r",
    issue: { number: 7, title: "Add CONTRIBUTING.md", body: "" },
    thread: [],
    secrets: [],
    canChangeWorkflows: true,
    failures: [{ check: "lint", output: `${"x".repeat(7000)}END` }],
  });
  assert.match(prompt, /## lint/);
  assert.match(prompt, /\[\.\.\. cut \.\.\.\]\nx+END/);
  assert.doesNotMatch(prompt, /x{6001}/);
});

test("the prompt names the workspace folder of the dev container, not a fixed path", () => {
  const prompt = builderPrompt({ repo: "o/r", workdir: "/workspaces/r", issue: { number: 7, title: "t", body: "" }, thread: [], secrets: [], canChangeWorkflows: true });
  assert.match(prompt, /checked out at \/workspaces\/r\./);
  assert.match(prompt, /one JSON file at \/workspaces\/r\/\.autopilot\/result\.json/);
  assert.doesNotMatch(prompt, /\/work\b/);
});

const secretsPromptCases: { secrets: string[]; expected: RegExp }[] = [
  { secrets: ["STRIPE_KEY", "DATABASE_URL"], expected: /only in the check containers: `STRIPE_KEY`, `DATABASE_URL`\./ },
  { secrets: [], expected: /The repo has no secrets\./ },
];

for (const { secrets, expected } of secretsPromptCases) {
  test(`the prompt names the secrets the checks get: [${secrets.join(", ")}]`, () => {
    assert.match(builderPrompt({ repo: "o/r", workdir: "/workspaces/r", issue: { number: 7, title: "t", body: "" }, thread: [], secrets, canChangeWorkflows: true }), expected);
  });
}

const resultCases: { name: string; text: string; valid: boolean }[] = [
  { name: "a summary", text: '{"summary":"done"}', valid: true },
  { name: "missing secrets", text: '{"summary":"needs a key","missing_secrets":["STRIPE_KEY"]}', valid: true },
  { name: "a secret name that is not an env name", text: '{"summary":"x","missing_secrets":["stripe key"]}', valid: false },
  { name: "an empty list of missing secrets", text: '{"summary":"x","missing_secrets":[]}', valid: false },
];

for (const { name, text, valid } of resultCases) {
  test(`builder result: ${name}`, () => {
    if (valid) assert.doesNotThrow(() => parseBuilderResult(text));
    else assert.throws(() => parseBuilderResult(text), /invalid/);
  });
}
