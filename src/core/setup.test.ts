import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { checkResources, isRepoEntry, itemStored, repoFileStored, installCommand, parseList, parseResources, parseSetupConfig, planHostSetup, RESOURCES_PROBE, TOOLS, type HostFacts, type HostPlan } from "./setup.ts";

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

const running: HostFacts = { hasHost: true, opToken: true, release: "/opt/autopilot-v1.2.0", service: "active" };

const hostPlans: { name: string; facts: HostFacts; request?: { version?: string; fromCheckout: boolean }; expected: HostPlan | RegExp }[] = [
  { name: "a running host is left alone", facts: running, expected: { kind: "ready" } },
  { name: "a running macOS host is left alone", facts: { ...running, release: "/Users/me/.autopilot/releases/v1.2.0", service: "running" }, expected: { kind: "ready" } },
  { name: "a running host stays alone even with a version asked", facts: running, request: { version: "v2.0.0", fromCheckout: false }, expected: { kind: "ready" } },
  { name: "a new host gets the latest release", facts: { hasHost: false, opToken: false, service: "not loaded" }, expected: { kind: "run", fromCheckout: false } },
  { name: "a new host gets the version asked", facts: { hasHost: false, opToken: false, service: "not loaded" }, request: { version: "v1.0.0", fromCheckout: false }, expected: { kind: "run", version: "v1.0.0", fromCheckout: false } },
  { name: "a host with a file but no release is installed", facts: { hasHost: true, opToken: true, service: "inactive" }, expected: { kind: "run", fromCheckout: false } },
  { name: "a stopped host keeps its release", facts: { ...running, service: "inactive" }, expected: { kind: "run", version: "v1.2.0", fromCheckout: false, problem: "service is inactive" } },
  { name: "a host in RestartSec keeps its release", facts: { ...running, service: "activating" }, expected: { kind: "run", version: "v1.2.0", fromCheckout: false, problem: "service is activating" } },
  { name: "a macOS host that is not loaded keeps its release", facts: { ...running, release: "/Users/me/.autopilot/releases/v1.2.0", service: "not loaded" }, expected: { kind: "run", version: "v1.2.0", fromCheckout: false, problem: "service is not loaded" } },
  { name: "a missing token on a running host keeps its release", facts: { ...running, opToken: false }, expected: { kind: "run", version: "v1.2.0", fromCheckout: false, problem: "the 1Password token file is missing" } },
  { name: "two problems are both named", facts: { ...running, opToken: false, service: "failed" }, expected: { kind: "run", version: "v1.2.0", fromCheckout: false, problem: "service is failed; the 1Password token file is missing" } },
  { name: "a stopped host moves to the version asked", facts: { ...running, service: "inactive" }, request: { version: "v2.0.0", fromCheckout: false }, expected: { kind: "run", version: "v2.0.0", fromCheckout: false, problem: "service is inactive" } },
  { name: "a stopped checkout host is not replaced by a release", facts: { ...running, release: "/opt/autopilot-0123456789ab", service: "inactive" }, expected: /checkout build 0123456789ab.*--from-checkout/ },
  { name: "a stopped checkout host is installed again from the checkout", facts: { ...running, release: "/opt/autopilot-0123456789ab", service: "inactive" }, request: { fromCheckout: true }, expected: { kind: "run", fromCheckout: true, problem: "service is inactive" } },
];

for (const { name, facts, request = { fromCheckout: false }, expected } of hostPlans) {
  test(`host plan: ${name}`, () => {
    const plan = planHostSetup(facts, request);
    if (expected instanceof RegExp) {
      assert.equal(plan.kind, "refuse");
      assert.match(plan.kind === "refuse" ? plan.reason : "", expected);
    } else assert.deepEqual(plan, expected);
  });
}

const repoEntries: { value: string; valid: boolean }[] = [
  { value: "octocat/app", valid: true },
  { value: "example-org/my.app_2", valid: true },
  { value: "octocat", valid: false },
  { value: "", valid: false },
  { value: "a/b/c", valid: false },
  { value: "octocat/", valid: false },
  { value: "/app", valid: false },
  { value: "octocat/app extra", valid: false },
  { value: "octocat/app\n", valid: false },
  { value: "octo_cat/app", valid: false },
  { value: "octocat/app;id", valid: false },
  { value: "octocat/$(id)", valid: false },
];

for (const { value, valid } of repoEntries) {
  test(`repo entry ${JSON.stringify(value)} is ${valid ? "valid" : "invalid"}`, () => {
    assert.equal(isRepoEntry(value), valid);
  });
}

const itemAnswers: { name: string; result: { ok: boolean; stderr: string }; stored: boolean | RegExp }[] = [
  { name: "op finds the item", result: { ok: true, stderr: "" }, stored: true },
  { name: "op says the item does not exist", result: { ok: false, stderr: `[ERROR] 2026/01/01 00:00:00 "github-app-private-key" isn't an item in the "autopilot" vault.` }, stored: false },
  { name: "op is locked", result: { ok: false, stderr: "[ERROR] 2026/01/01 00:00:00 authorization prompt dismissed" }, stored: /authorization prompt dismissed/ },
  { name: "op has no network", result: { ok: false, stderr: "[ERROR] dial tcp: lookup my.1password.com: no such host" }, stored: /no such host/ },
  { name: "op cannot find the vault", result: { ok: false, stderr: `[ERROR] "autopilot" isn't a vault in this account.` }, stored: /isn't a vault/ },
  { name: "op fails without a message", result: { ok: false, stderr: "" }, stored: /op item get github-app-private-key/ },
];

for (const { name, result, stored } of itemAnswers) {
  test(`item stored: ${name}`, () => {
    if (stored instanceof RegExp) assert.throws(() => itemStored("github-app-private-key", result), stored);
    else assert.equal(itemStored("github-app-private-key", result), stored);
  });
}

const fileAnswers: { name: string; result: { ok: boolean; stderr: string }; stored: boolean | RegExp }[] = [
  { name: "the file exists", result: { ok: true, stderr: "" }, stored: true },
  { name: "the file is missing", result: { ok: false, stderr: "gh: Not Found (HTTP 404)" }, stored: false },
  { name: "gh has no access", result: { ok: false, stderr: "gh: Resource not accessible (HTTP 403)" }, stored: /HTTP 403/ },
  { name: "GitHub fails", result: { ok: false, stderr: "gh: Bad Gateway (HTTP 502)" }, stored: /HTTP 502/ },
  { name: "gh is not signed in", result: { ok: false, stderr: "gh: To use GitHub CLI, run: gh auth login" }, stored: /gh auth login/ },
];

for (const { name, result, stored } of fileAnswers) {
  test(`repo file stored: ${name}`, () => {
    if (stored instanceof RegExp) assert.throws(() => repoFileStored("repos/o/r/contents/f", result), stored);
    else assert.equal(repoFileStored("repos/o/r/contents/f", result), stored);
  });
}
