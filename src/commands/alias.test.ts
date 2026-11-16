import { test } from "node:test";
import assert from "node:assert/strict";
import { AliasError, aliasFile, aliasNameProblem, aliasLine, parseAliasName, shellOf, withAlias, withoutAlias, type LoginShell } from "./alias.ts";

const shellCases: { value: string | undefined; expected: LoginShell | undefined }[] = [
  { value: "/bin/zsh", expected: "zsh" },
  { value: "/opt/homebrew/bin/bash", expected: "bash" },
  { value: "/usr/bin/fish", expected: "fish" },
  { value: "/bin/sh", expected: undefined },
  { value: "/usr/bin/nu", expected: undefined },
  { value: undefined, expected: undefined },
];

for (const { value, expected } of shellCases) {
  test(`SHELL=${value} is ${expected ?? "not supported"}`, () => {
    if (expected) assert.equal(shellOf(value), expected);
    else assert.throws(() => shellOf(value), /zsh, bash or fish/);
  });
}

const fileCases: { shell: LoginShell; platform: NodeJS.Platform; expected: string }[] = [
  { shell: "zsh", platform: "darwin", expected: "/home/me/.zshrc" },
  { shell: "zsh", platform: "linux", expected: "/home/me/.zshrc" },
  { shell: "bash", platform: "linux", expected: "/home/me/.bashrc" },
  { shell: "bash", platform: "darwin", expected: "/home/me/.bash_profile" },
  { shell: "fish", platform: "linux", expected: "/home/me/.config/fish/conf.d/autopilot.fish" },
  { shell: "fish", platform: "darwin", expected: "/home/me/.config/fish/conf.d/autopilot.fish" },
];

for (const { shell, platform, expected } of fileCases) {
  test(`${shell} on ${platform} keeps the alias in ${expected}`, () => {
    assert.equal(aliasFile(shell, platform, "/home/me"), expected);
  });
}

const lineCases: { shell: LoginShell; expected: string }[] = [
  { shell: "zsh", expected: "alias ap='autopilot' # autopilot alias" },
  { shell: "bash", expected: "alias ap='autopilot' # autopilot alias" },
  { shell: "fish", expected: "alias ap autopilot # autopilot alias" },
];

for (const { shell, expected } of lineCases) {
  test(`the ${shell} alias line is ${expected}`, () => {
    assert.equal(aliasLine(shell, "ap"), expected);
  });
}

const LINE = "alias ap='autopilot' # autopilot alias";

const addCases: { name: string; text: string; expected: string }[] = [
  { name: "an empty file", text: "", expected: `${LINE}\n` },
  { name: "a file with a last newline", text: "export A=1\n", expected: `export A=1\n${LINE}\n` },
  { name: "a file without a last newline", text: "export A=1", expected: `export A=1\n${LINE}\n` },
  { name: "a file with the same alias", text: `export A=1\n${LINE}\n`, expected: `export A=1\n${LINE}\n` },
  { name: "a file with another autopilot alias", text: "alias apx='autopilot' # autopilot alias\nexport A=1\n", expected: `export A=1\n${LINE}\n` },
];

for (const { name, text, expected } of addCases) {
  test(`adds the alias to ${name}`, () => {
    assert.equal(withAlias(text, LINE), expected);
  });
}

const removeCases: { name: string; text: string; expected: string }[] = [
  { name: "the last line", text: `export A=1\n${LINE}\n`, expected: "export A=1\n" },
  { name: "a middle line", text: `export A=1\n${LINE}\nexport B=2\n`, expected: "export A=1\nexport B=2\n" },
  { name: "the only line", text: `${LINE}\n`, expected: "" },
  { name: "a file without it", text: "alias ap='other'\n", expected: "alias ap='other'\n" },
];

for (const { name, text, expected } of removeCases) {
  test(`removes the alias on ${name}, and only that line`, () => {
    assert.equal(withoutAlias(text), expected);
  });
}

test("adding then removing gives back a file that ends with a newline", () => {
  const text = "export A=1\n# my settings\n";
  assert.equal(withoutAlias(withAlias(text, LINE)), text);
});

for (const value of ["ap", "auto_pilot", "ap2", "a-p"]) {
  test(`accepts the alias name ${value}`, () => {
    assert.equal(parseAliasName(value), value);
    assert.equal(aliasNameProblem(value), undefined);
  });
}

for (const value of ["", "2ap", "a p", "ap;id", "$(id)", "a'b"]) {
  test(`rejects the alias name ${JSON.stringify(value)}`, () => {
    assert.throws(() => parseAliasName(value), (error) => error instanceof AliasError && /not an alias name/.test(error.message));
    assert.match(aliasNameProblem(value) ?? "", /not an alias name/);
  });
}
