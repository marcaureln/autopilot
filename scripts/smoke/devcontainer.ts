// Starts real dev containers the way the checks and the builder do, with no GitHub, App or 1Password.
// CI runs it on a host that `scripts/setup.sh` prepared. Usage: node scripts/smoke/devcontainer.ts
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Audit } from "../../src/core/audit.ts";
import { cliDevcontainer } from "../../src/core/devcontainer-cli.ts";
import { checkCommand, EnvironmentRefused, RUN_DIR, SECRETS_NAME, shellEnvFile, startEnvironment, stopEnvironment } from "../../src/core/environment.ts";
import { claudeCodeVersion, MANAGED_SETTINGS } from "../../src/harness/claude.ts";

const audit: Audit = () => undefined;
const limits = { memory: "2g", cpus: 2, pids: 512 };
const INTERNET = `node -e 'fetch("https://example.com").then(() => process.exit(0), () => process.exit(7))'`;

function copyRepo(devcontainer: object): string {
  const workspace = join(mkdtempSync(join(tmpdir(), "autopilot-smoke-")), "repo");
  cpSync(new URL("repo", import.meta.url).pathname, workspace, { recursive: true });
  writeFileSync(join(workspace, ".devcontainer/devcontainer.json"), JSON.stringify(devcontainer));
  return workspace;
}

function leftOver(idLabel: string): string {
  return execFileSync("docker", ["ps", "--all", "--quiet", "--filter", `label=${idLabel}`], { encoding: "utf8" }).trim();
}

console.log("==> the guardrails refuse a privileged config");
{
  const workspace = copyRepo({ dockerComposeFile: "compose.yaml", service: "app", workspaceFolder: "/workspace", runArgs: ["--privileged"] });
  await assert.rejects(startEnvironment({ devcontainer: cliDevcontainer, workspace, idLabel: "autopilot.job=smoke-bad", limits, mounts: [], claudeCodeVersion: undefined, timeoutMs: 600_000, audit }), EnvironmentRefused);
}

console.log("==> a compose config: install, Claude Code, network cut, checks with a secret");
{
  const workspace = copyRepo({ name: "smoke", dockerComposeFile: "compose.yaml", service: "app", workspaceFolder: "/workspace", postCreateCommand: "npm ci && touch /tmp/installed" });
  const runDir = join(workspace, "..", "run");
  mkdirSync(runDir, { mode: 0o700 });
  const idLabel = "autopilot.job=smoke-compose";
  const version = claudeCodeVersion();
  try {
    const up = await startEnvironment({ devcontainer: cliDevcontainer, workspace, idLabel, limits, mounts: [{ source: runDir, target: RUN_DIR, readonly: true }, MANAGED_SETTINGS], claudeCodeVersion: version, timeoutMs: 900_000, audit });
    if (up.kind === "failed") console.error(up.result.output);
    assert(up.kind === "up", "the dev container did not start");
    const exec = (command: string, withSecrets = false) => cliDevcontainer.exec(up.containerId, checkCommand(command, up.workspaceFolder, withSecrets), { timeoutMs: 120_000 });

    const setup = await exec("test -f /tmp/installed && pwd && claude --version");
    assert.equal(setup.exit, 0, setup.output);
    assert.match(setup.output, /^\/workspace$/m);
    assert.match(setup.output, new RegExp(version.replaceAll(".", "\\.")));

    assert.equal((await exec(INTERNET)).exit, 0, "the install step has the network");
    await cliDevcontainer.cutNetwork(up.containerId);
    assert.equal((await exec(INTERNET)).exit, 7, "the checks have no internet");

    writeFileSync(join(runDir, SECRETS_NAME), shellEnvFile({ SMOKE_SECRET: "it's $not `a` secret" }), { mode: 0o600, flag: "wx" });
    const redis = await exec("npm test", true);
    assert.equal(redis.exit, 0, redis.output);
    assert.match(redis.output, /PONG/);
    assert.equal((await exec(`test "$SMOKE_SECRET" = "it's \\$not \\\`a\\\` secret"`, true)).exit, 0, "the secret reaches the check");
    assert.equal((await exec("exit 3")).exit, 3);
  } finally {
    await stopEnvironment(cliDevcontainer, idLabel, audit);
  }
  assert.equal(leftOver(idLabel), "", "down removes every container of the job");
}

console.log("==> an image config with a workspace folder: no network after the cut");
{
  const workspace = copyRepo({ name: "image", image: "node:26.13.1", workspaceFolder: "/work", postCreateCommand: "npm ci" });
  const idLabel = "autopilot.job=smoke-image";
  try {
    const up = await startEnvironment({ devcontainer: cliDevcontainer, workspace, idLabel, limits, mounts: [], claudeCodeVersion: undefined, timeoutMs: 600_000, audit });
    if (up.kind === "failed") console.error(up.result.output);
    assert(up.kind === "up", "the dev container did not start");
    await cliDevcontainer.cutNetwork(up.containerId);
    const result = await cliDevcontainer.exec(up.containerId, checkCommand(`test -f package.json && pwd && cat /sys/fs/cgroup/pids.max && ${INTERNET}`, up.workspaceFolder, false), { timeoutMs: 120_000 });
    assert.equal(result.exit, 7, result.output);
    assert.match(result.output, /^\/work\n512$/m);
  } finally {
    await stopEnvironment(cliDevcontainer, idLabel, audit);
  }
  assert.equal(leftOver(idLabel), "");
}

console.log("==> smoke test passed");
