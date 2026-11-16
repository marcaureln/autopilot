import { test } from "node:test";
import assert from "node:assert/strict";
import { envFile, itemTitle, parseEnvFile, referencedSecrets, refusedSecrets, removeSecretReference, secretNames, secretReference, setSecretReference, withSecrets } from "./repo-secrets.ts";

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

const envCases: { name: string; text: string; expected: [string, string][] }[] = [
  { name: "plain lines", text: "A=1\nB_KEY=two words\n", expected: [["A", "1"], ["B_KEY", "two words"]] },
  { name: "comments, blank lines and export", text: "# c\n\nexport A=1\n", expected: [["A", "1"]] },
  { name: "an inline comment after a space", text: "A=1 # note\nB=x#y\n", expected: [["A", "1"], ["B", "x#y"]] },
  { name: "double quotes with escapes", text: 'A="a b\\n\\"c\\""\n', expected: [["A", 'a b\n"c"']] },
  { name: "single quotes are literal", text: "A='a\\nb # c'\n", expected: [["A", "a\\nb # c"]] },
  { name: "an empty value", text: "A=\n", expected: [["A", ""]] },
  { name: "spaces around the equal sign", text: "A = 1\r\n", expected: [["A", "1"]] },
];

for (const { name, text, expected } of envCases) {
  test(`env file: ${name}`, () => {
    assert.deepEqual(parseEnvFile(text), expected);
  });
}

const badEnvCases: { name: string; text: string; error: RegExp }[] = [
  { name: "a lowercase name", text: "a=1\n", error: /line 1: "a" is not a secret name/ },
  { name: "no equal sign", text: "A=1\nJUSTTEXT\n", error: /line 2: no NAME=value/ },
  { name: "an open quote", text: 'A="abc\n', error: /line 1: the quote is not closed/ },
];

for (const { name, text, error } of badEnvCases) {
  test(`env file: refuses ${name}, without the value in the message`, () => {
    assert.throws(() => parseEnvFile(text), (thrown: unknown) => thrown instanceof Error && error.test(thrown.message) && !thrown.message.includes("abc"));
  });
}

test("the docker env file has one NAME=value line per secret", () => {
  assert.equal(envFile({ A: "1", B: "x = y" }), "A=1\nB=x = y\n");
});

test("the docker env file refuses a value on more than one line, and names only the key", () => {
  assert.throws(() => envFile({ PEM: "-----BEGIN\nabc" }), /PEM has more than one line/);
});

const config = `{
  "version": 1,
  "stack": ["node"]
}
`;

test("set adds the reference and keeps the other fields", () => {
  const once = setSecretReference(config, "B", "op://autopilot/x_y/B");
  const twice = setSecretReference(once, "A", "op://autopilot/x_y/A");
  assert.deepEqual(JSON.parse(twice), { version: 1, stack: ["node"], secrets: { B: "op://autopilot/x_y/B", A: "op://autopilot/x_y/A" } });
  assert.ok(twice.endsWith("}\n"));
});

test("set replaces a reference, rm removes it and drops an empty secrets object", () => {
  const set = setSecretReference(config, "A", "op://autopilot/x_y/A");
  assert.equal(setSecretReference(set, "A", "op://autopilot/x_y/A"), set);
  assert.deepEqual(JSON.parse(removeSecretReference(set, "A")), { version: 1, stack: ["node"] });
});

const note = { id: "notesPlain", type: "STRING", purpose: "NOTES", label: "notesPlain", value: "" };

test("a new item holds one concealed field per secret", () => {
  assert.deepEqual(withSecrets(undefined, repo, { A: "1" }), {
    title: "acme_app.web",
    category: "SECURE_NOTE",
    fields: [
      { ...note, value: "Runtime secrets for Acme/App.Web, written by autopilot secrets." },
      { id: "A", type: "CONCEALED", label: "A", value: "1" },
    ],
  });
});

test("an existing item keeps its other fields and gets the new values", () => {
  const item = { id: "abc", title: "acme_app.web", category: "SECURE_NOTE", vault: { id: "v" }, fields: [note, { id: "A", type: "CONCEALED", label: "A", value: "old" }, { id: "B", type: "CONCEALED", label: "B", value: "b" }] };
  assert.deepEqual(withSecrets(item, repo, { A: "new", C: "c" }).fields, [
    note,
    { id: "A", type: "CONCEALED", label: "A", value: "new" },
    { id: "B", type: "CONCEALED", label: "B", value: "b" },
    { id: "C", type: "CONCEALED", label: "C", value: "c" },
  ]);
});

const namesCases: { name: string; item: unknown; expected: string[] }[] = [
  { name: "no item", item: undefined, expected: [] },
  { name: "secret fields only", item: { fields: [note, { label: "A", type: "CONCEALED" }, { label: "lower", type: "CONCEALED" }] }, expected: ["A"] },
  { name: "not an item", item: { fields: "x" }, expected: [] },
];

for (const { name, item, expected } of namesCases) {
  test(`secret names in the item: ${name}`, () => {
    assert.deepEqual(secretNames(item), expected);
  });
}

test("the referenced secrets are the keys of the config's secrets", () => {
  assert.deepEqual(referencedSecrets(setSecretReference(config, "A", "op://autopilot/x_y/A")), ["A"]);
  assert.deepEqual(referencedSecrets(config), []);
});
