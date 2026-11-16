import { test } from "node:test";
import assert from "node:assert/strict";
import { parseSecretsCommand, type SecretsCommand } from "./secrets.ts";

const cases: { args: string[]; fromEnv?: string; expected: SecretsCommand | RegExp }[] = [
  { args: ["set", "STRIPE_KEY"], expected: { action: "set", name: "STRIPE_KEY" } },
  { args: ["set"], fromEnv: ".env", expected: { action: "set-from-env", file: ".env" } },
  { args: ["list"], expected: { action: "list" } },
  { args: ["rm", "STRIPE_KEY"], expected: { action: "rm", name: "STRIPE_KEY" } },
  { args: ["set", "stripe-key"], expected: /is not a secret name/ },
  { args: ["set", "STRIPE_KEY", "value"], expected: /never an argument/ },
  { args: ["rm", "A", "B"], expected: /usage/ },
  { args: ["set", "STRIPE_KEY"], fromEnv: ".env", expected: /usage/ },
  { args: ["set"], expected: /usage/ },
  { args: ["get", "A"], expected: /usage/ },
  { args: [], expected: /usage/ },
];

for (const { args, fromEnv, expected } of cases) {
  test(`secrets ${args.join(" ")}${fromEnv ? ` --from-env ${fromEnv}` : ""}`, () => {
    if (expected instanceof RegExp) assert.throws(() => parseSecretsCommand(args, fromEnv), expected);
    else assert.deepEqual(parseSecretsCommand(args, fromEnv), expected);
  });
}
