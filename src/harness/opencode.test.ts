import { test } from "node:test";
import assert from "node:assert/strict";
import type { Agent } from "../core/config.ts";
import { PROMPT_FILE } from "../core/environment.ts";
import { opencode } from "./opencode.ts";

const commandCases: { name: string; effort: Agent["effort"]; model: string }[] = [
  { name: "no effort keeps the model as it is", effort: undefined, model: "anthropic/claude-sonnet-5-5" },
  { name: "the effort is the model variant", effort: "high", model: "anthropic/claude-sonnet-5-5#high" },
];

for (const { name, effort, model } of commandCases) {
  test(`opencode command: ${name}`, () => {
    const command = opencode.command("anthropic/claude-sonnet-5-5", effort);
    assert.equal(command[command.indexOf("--model") + 1], model);
    assert.equal(command[command.indexOf("--file") + 1], PROMPT_FILE);
    assert.ok(command.includes("--auto") && command.includes("--standalone"));
  });
}

const credentialCases: { name: string; apiKeys: Record<string, string>; missing: RegExp | undefined }[] = [
  { name: "an API key", apiKeys: { ANTHROPIC_API_KEY: "k" }, missing: undefined },
  { name: "no API key", apiKeys: {}, missing: /secrets\.api_keys/ },
];

for (const { name, apiKeys, missing } of credentialCases) {
  test(`opencode credentials: ${name}`, () => {
    const credentials = { claudeToken: "t", apiKeys };
    const problem = opencode.missingCredential(credentials);
    if (missing) assert.match(problem ?? "", missing);
    else assert.equal(problem, undefined);
    assert.deepEqual(opencode.secretEnv(credentials), apiKeys);
  });
}

test("opencode reads no project config, but reads the AGENTS.md of the checkout", () => {
  const env = opencode.env("/workspaces/app");
  assert.equal(env.OPENCODE_DISABLE_PROJECT_CONFIG, "1");
  assert.deepEqual(JSON.parse(env.OPENCODE_CONFIG_CONTENT ?? ""), { instructions: ["/workspaces/app/AGENTS.md"] });
});
