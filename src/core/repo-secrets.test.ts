import { test } from "node:test";
import assert from "node:assert/strict";
import { envFile, itemTitle, refusedSecrets, secretReference } from "./repo-secrets.ts";

const repo = { owner: "Acme", name: "App.Web" };

test("one 1Password item per repo, named so that the owner and the repo split at the first underscore", () => {
  assert.equal(itemTitle(repo), "acme_app.web");
  assert.equal(secretReference(repo, "STRIPE_KEY"), "op://autopilot/acme_app.web/STRIPE_KEY");
});

const refusedCases: { name: string; secrets: Record<string, string>; expected: string[] }[] = [
  { name: "the repo's own item", secrets: { STRIPE_KEY: "op://autopilot/acme_app.web/STRIPE_KEY" }, expected: [] },
  { name: "another field name than the key", secrets: { STRIPE_KEY: "op://autopilot/acme_app.web/OTHER" }, expected: ["STRIPE_KEY"] },
  { name: "the App key of the host", secrets: { KEY: "op://autopilot/github-app-private-key/app.pem" }, expected: ["KEY"] },
  { name: "the Claude token of the host", secrets: { KEY: "op://autopilot/claude-token/credential" }, expected: ["KEY"] },
  { name: "the service account token", secrets: { KEY: "op://autopilot/op-service-account-token/password" }, expected: ["KEY"] },
  { name: "another repo's item", secrets: { KEY: "op://autopilot/acme_other/KEY" }, expected: ["KEY"] },
  { name: "another vault", secrets: { KEY: "op://Personal/acme_app.web/KEY" }, expected: ["KEY"] },
  { name: "a path trick", secrets: { KEY: "op://autopilot/acme_app.web/../claude-token/KEY" }, expected: ["KEY"] },
  { name: "an encoded separator", secrets: { KEY: "op://autopilot/acme_app.web%2FKEY" }, expected: ["KEY"] },
  { name: "a query string", secrets: { KEY: "op://autopilot/acme_app.web/KEY?attribute=otp" }, expected: ["KEY"] },
  { name: "the item in another case", secrets: { KEY: "op://autopilot/ACME_APP.WEB/KEY" }, expected: ["KEY"] },
  { name: "a mix", secrets: { A: "op://autopilot/acme_app.web/A", B: "op://autopilot/claude-token/credential" }, expected: ["B"] },
];

for (const { name, secrets, expected } of refusedCases) {
  test(`reference: ${name}`, () => {
    assert.deepEqual(refusedSecrets(repo, secrets), expected);
  });
}

test("the docker env file has one NAME=value line per secret", () => {
  assert.equal(envFile({ A: "1", B: "x = y" }), "A=1\nB=x = y\n");
});

test("the docker env file refuses a value on more than one line, and names only the key", () => {
  assert.throws(() => envFile({ PEM: "-----BEGIN\nabc" }), /PEM has more than one line/);
});
