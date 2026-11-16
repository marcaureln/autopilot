import { test } from "node:test";
import assert from "node:assert/strict";
import { botIdentity, builderPrompt, commitProblems, neutralize, parseBuilderResult, pullBody, type Commit } from "./builder.ts";

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

test("the pull request body links the issue first and drops attribution lines from the summary", () => {
  assert.equal(pullBody(7, "Adds CONTRIBUTING.md.\n🤖 Generated with Claude Code\nFixes #8"), "Fixes #7\n\nAdds CONTRIBUTING.md.\nFi\u200bxes #8\n");
});

test("a fix prompt carries the failed check output, cut to its end", () => {
  const prompt = builderPrompt({
    repo: "o/r",
    workdir: "/workspaces/r",
    issue: { number: 7, title: "Add CONTRIBUTING.md", body: "" },
    thread: [],
    secrets: [],
    failures: [{ check: "lint", output: `${"x".repeat(7000)}END` }],
  });
  assert.match(prompt, /## lint/);
  assert.match(prompt, /\[\.\.\. cut \.\.\.\]\nx+END/);
  assert.doesNotMatch(prompt, /x{6001}/);
});

test("the prompt names the workspace folder of the dev container, not a fixed path", () => {
  const prompt = builderPrompt({ repo: "o/r", workdir: "/workspaces/r", issue: { number: 7, title: "t", body: "" }, thread: [], secrets: [] });
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
    assert.match(builderPrompt({ repo: "o/r", workdir: "/workspaces/r", issue: { number: 7, title: "t", body: "" }, thread: [], secrets }), expected);
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
