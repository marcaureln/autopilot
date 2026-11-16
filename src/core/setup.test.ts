import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { checkResources, installCommand, parseList, parseResources, parseSetupConfig, RESOURCES_PROBE, TOOLS } from "./setup.ts";

const GIB = 1024 ** 3;

const validConfigs: { name: string; text: string }[] = [
  { name: "an empty file", text: "{}" },
  { name: "every answer", text: JSON.stringify({ app_id: 42, host: "user@my-host", owner: "octocat", allow: ["octocat", "example-org/app"], init: ["octocat/app"], alias: "ap" }) },
  { name: "the local host and no alias", text: JSON.stringify({ host: "local", alias: false }) },
];

for (const { name, text } of validConfigs) {
  test(`setup file: accepts ${name}`, () => {
    assert.deepEqual(parseSetupConfig(text, "setup.json"), JSON.parse(text));
  });
}

const invalidConfigs: { name: string; value: unknown }[] = [
  { name: "an unknown field", value: { claude_token: "sk-secret" } },
  { name: "an App id as text", value: { app_id: "42" } },
  { name: "an SSH option as the host", value: { host: "-oProxyCommand=x" } },
  { name: "a bad allow entry", value: { allow: ["a/b/c"] } },
  { name: "an owner instead of a repo in init", value: { init: ["octocat"] } },
  { name: "alias true", value: { alias: true } },
  { name: "a bad alias name", value: { alias: "a b" } },
];

for (const { name, value } of invalidConfigs) {
  test(`setup file: refuses ${name}`, () => {
    assert.throws(() => parseSetupConfig(JSON.stringify(value), "setup.json"), /Invalid setup file setup\.json/);
  });
}

for (const tool of TOOLS) {
  test(`gives an install command for ${tool} on macOS and Linux`, () => {
    assert.ok(installCommand(tool, "darwin").length > 0);
    assert.ok(installCommand(tool, "linux").length > 0);
  });
}

test("the resources probe runs on this machine and parses", () => {
  const resources = parseResources(execFileSync("sh", ["-c", RESOURCES_PROBE], { encoding: "utf8" }));
  assert.ok(resources.arch.length > 0);
  assert.ok(resources.memoryBytes > 0);
  assert.ok(resources.diskBytes > 0);
});

test("parses the probe output", () => {
  assert.deepEqual(parseResources("aarch64\n8237309952\n50000000000\n"), { arch: "aarch64", memoryBytes: 8237309952, diskBytes: 50000000000 });
});

for (const stdout of ["", "aarch64\n", "aarch64\nlots\n100\n", "aarch64\n100\n"]) {
  test(`refuses the probe output ${JSON.stringify(stdout)}`, () => {
    assert.throws(() => parseResources(stdout), /cannot read the architecture/);
  });
}

const resourceCases: { name: string; arch: string; memory: number; disk: number; errors: number; warnings: number }[] = [
  { name: "a large arm64 host", arch: "aarch64", memory: 8 * GIB, disk: 100 * GIB, errors: 0, warnings: 0 },
  { name: "an x86_64 host", arch: "x86_64", memory: 16 * GIB, disk: 200 * GIB, errors: 0, warnings: 0 },
  { name: "a Mac", arch: "arm64", memory: 16 * GIB, disk: 200 * GIB, errors: 0, warnings: 0 },
  { name: "a 32-bit board", arch: "armv7l", memory: 8 * GIB, disk: 100 * GIB, errors: 1, warnings: 0 },
  { name: "a host with 4 GiB", arch: "aarch64", memory: 4 * GIB, disk: 100 * GIB, errors: 0, warnings: 1 },
  { name: "a full disk", arch: "aarch64", memory: 8 * GIB, disk: 5 * GIB, errors: 0, warnings: 1 },
];

for (const { name, arch, memory, disk, errors, warnings } of resourceCases) {
  test(`resources: ${name}`, () => {
    const check = checkResources({ arch, memoryBytes: memory, diskBytes: disk });
    assert.equal(check.errors.length, errors);
    assert.equal(check.warnings.length, warnings);
  });
}

const lists: { value: string; expected: string[] }[] = [
  { value: "", expected: [] },
  { value: "octocat", expected: ["octocat"] },
  { value: "octocat, example-org/app", expected: ["octocat", "example-org/app"] },
  { value: " a  b,a ", expected: ["a", "b"] },
];

for (const { value, expected } of lists) {
  test(`reads the list ${JSON.stringify(value)}`, () => {
    assert.deepEqual(parseList(value), expected);
  });
}
