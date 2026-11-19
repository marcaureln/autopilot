import { test } from "node:test";
import assert from "node:assert/strict";
import { envFile, itemTitle, parseEnvFile, parseSecretsFile } from "./repo-secrets.ts";

const repo = { owner: "Acme", name: "App.Web" };

test("one env file per repo, named so that the owner and the repo split at the first underscore", () => {
  assert.equal(itemTitle(repo), "acme_app.web");
});

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

const exactCases: { name: string; values: Record<string, string> }[] = [
  { name: "a value with a comment sign", values: { DB_PASSWORD: "hunter2 #prod" } },
  { name: "quotes", values: { A: '"quoted"', B: "'open" } },
  { name: "spaces at both ends", values: { A: "  lead", B: "trail  " } },
  { name: "an equal sign and a tab", values: { URL: "a=b=c\t#c" } },
  { name: "a backslash", values: { A: "x\\ny" } },
  { name: "an empty value", values: { A: "" } },
];
for (const { name, values } of exactCases) {
  test(`the host secrets file keeps ${name} exactly`, () => {
    assert.deepEqual(parseSecretsFile(envFile(values)), values);
  });
}

test("the host secrets file refuses a line that is not NAME=value", () => {
  assert.throws(() => parseSecretsFile("not a secret\n"), /NAME=value/);
});
