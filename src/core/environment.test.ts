import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Devcontainer } from "./devcontainer-cli.ts";
import { checkCommand, COMPOSE_OVERRIDE_FILE, EnvironmentRefused, overrideFiles, parseUpResult, SECRETS_FILE, shellEnvFile, startEnvironment } from "./environment.ts";

const limits = { memory: "6g", cpus: 2, pids: 1024 };
const mounts = [{ source: "/tmp/job/settings.json", target: "/etc/claude-code/managed-settings.json", readonly: true }];

test("an image config gets the host caps as runArgs, the host mounts, and root as the remote user", () => {
  const configuration = { name: "app", image: "node:26.13.1", postCreateCommand: "npm ci", remoteUser: "node", configFilePath: { path: "/x" } };
  assert.deepEqual(overrideFiles(configuration, { limits, mounts, composeServices: undefined }), {
    devcontainer: {
      name: "app",
      image: "node:26.13.1",
      postCreateCommand: "npm ci",
      remoteUser: "root",
      runArgs: ["--memory=6g", "--memory-swap=6g", "--cpus=2", "--pids-limit=1024", "--security-opt=no-new-privileges"],
      mounts: ["type=bind,source=/tmp/job/settings.json,target=/etc/claude-code/managed-settings.json,readonly"],
    },
  });
});

test("an image config with a workspace folder gets the repo mounted there", () => {
  const { devcontainer } = overrideFiles({ image: "node:26.13.1", workspaceFolder: "/work" }, { limits, mounts: [], composeServices: undefined });
  assert.equal(devcontainer.workspaceMount, "type=bind,source=${localWorkspaceFolder},target=/work");
});

test("a compose config gets a compose file with the caps on each service and the mounts on the dev container", () => {
  const configuration = { name: "app", dockerComposeFile: "compose.yaml", service: "app", workspaceFolder: "/workspace" };
  const composeServices = { app: { image: "node:26.13.1" }, db: { image: "postgres:18.1" }, sidecar: { image: "busybox:1.37.0", network_mode: "service:db" } };
  const caps = { mem_limit: "6g", memswap_limit: "6g", cpus: 2, pids_limit: 1024, security_opt: ["no-new-privileges:true"] };
  assert.deepEqual(overrideFiles(configuration, { limits, mounts, composeServices }), {
    devcontainer: { name: "app", dockerComposeFile: ["compose.yaml", COMPOSE_OVERRIDE_FILE], service: "app", workspaceFolder: "/workspace", remoteUser: "root" },
    compose: {
      services: {
        app: { ...caps, networks: ["default", "autopilot-services"], volumes: [{ type: "bind", source: "/tmp/job/settings.json", target: "/etc/claude-code/managed-settings.json", read_only: true }] },
        db: { ...caps, networks: ["default", "autopilot-services"] },
        sidecar: caps,
      },
      networks: { "autopilot-services": { internal: true } },
    },
  });
});

test("a list of compose files keeps its order, the host file comes last", () => {
  const { devcontainer } = overrideFiles({ dockerComposeFile: ["a.yaml", "b.yaml"], service: "app" }, { limits, mounts: [], composeServices: { app: {} } });
  assert.deepEqual(devcontainer.dockerComposeFile, ["a.yaml", "b.yaml", COMPOSE_OVERRIDE_FILE]);
});

const envCases: { name: string; secrets: Record<string, string>; expected: string }[] = [
  { name: "no secret", secrets: {}, expected: "" },
  { name: "plain values", secrets: { A: "abc", B: "x y" }, expected: "export A='abc'\nexport B='x y'\n" },
  { name: "shell characters stay literal", secrets: { A: "$HOME `id` \"q\"" }, expected: "export A='$HOME `id` \"q\"'\n" },
  { name: "a single quote", secrets: { A: "it's" }, expected: "export A='it'\\''s'\n" },
  { name: "a value on two lines", secrets: { A: "line1\nline2" }, expected: "export A='line1\nline2'\n" },
];

for (const { name, secrets, expected } of envCases) {
  test(`shell env file: ${name}`, () => {
    assert.equal(shellEnvFile(secrets), expected);
  });
}

test("a check command runs in the workspace folder and reads the secrets file only when there are secrets", () => {
  assert.deepEqual(checkCommand("npm test", "/workspace", false), ["sh", "-c", 'cd "$1" && exec sh -c "$2"', "sh", "/workspace", "npm test"]);
  assert.deepEqual(checkCommand("npm test", "/workspace", true), ["sh", "-c", `cd "$1" && set -a && . ${SECRETS_FILE} && set +a && exec sh -c "$2"`, "sh", "/workspace", "npm test"]);
});

const upCases: { name: string; stdout: string; expected: ReturnType<typeof parseUpResult> }[] = [
  {
    name: "an image container",
    stdout: 'some log\n{"outcome":"success","containerId":"abc","remoteUser":"root","remoteWorkspaceFolder":"/workspaces/app"}\n',
    expected: { kind: "up", containerId: "abc", workspaceFolder: "/workspaces/app" },
  },
  {
    name: "a compose container",
    stdout: '{"outcome":"success","containerId":"abc","composeProjectName":"app_devcontainer","remoteWorkspaceFolder":"/workspace"}',
    expected: { kind: "up", containerId: "abc", workspaceFolder: "/workspace" },
  },
  { name: "a failure", stdout: '{"outcome":"error","message":"Command failed: npm ci","description":"postCreateCommand failed"}', expected: { kind: "failed", message: "postCreateCommand failed: Command failed: npm ci" } },
  { name: "no result line", stdout: "", expected: { kind: "failed", message: "the Dev Container CLI wrote no result" } },
];

for (const { name, stdout, expected } of upCases) {
  test(`up result: ${name}`, () => {
    assert.deepEqual(parseUpResult(stdout), expected);
  });
}

function fakeDevcontainer(configuration: Record<string, unknown>, services: Record<string, Record<string, unknown>>, calls: string[]): Devcontainer {
  return {
    readConfiguration: async (workspace) => ({ configuration, merged: configuration, configFile: join(workspace, ".devcontainer", "devcontainer.json") }),
    composeConfig: async () => ({ services }),
    up: async ({ overrideConfig }) => {
      calls.push(overrideConfig);
      return { exit: 0, timedOut: false, output: "", truncated: false, stdout: '{"outcome":"success","containerId":"abc","remoteWorkspaceFolder":"/workspaces/app"}' };
    },
    exec: async () => ({ exit: 0, timedOut: false, output: "", truncated: false }),
    cutNetwork: async () => {},
    down: async () => {},
  };
}

const startCases: { name: string; configuration: Record<string, unknown>; services: Record<string, Record<string, unknown>>; refused: RegExp | undefined }[] = [
  { name: "an exact image starts", configuration: { image: "node:26.13.1" }, services: {}, refused: undefined },
  { name: "runArgs are refused", configuration: { image: "node:26.13.1", runArgs: ["--privileged"] }, services: {}, refused: /runArgs/ },
  { name: "a build context outside the repo is refused", configuration: { build: { dockerfile: "Dockerfile", context: "../.." } }, services: {}, refused: /build context/ },
  { name: "an absolute build context is refused", configuration: { build: { dockerfile: "Dockerfile", context: "/" } }, services: {}, refused: /build context/ },
  {
    name: "a dev container that shares the network of a service is refused",
    configuration: { dockerComposeFile: "compose.yaml", service: "app" },
    services: { app: { image: "node:26.13.1", network_mode: "service:db" }, db: { image: "postgres:18.1" } },
    refused: /compose service app: the dev container cannot have `network_mode`/,
  },
];

for (const { name, configuration, services, refused } of startCases) {
  test(`start: ${name}`, async () => {
    const workspace = realpathSync(mkdtempSync(join(tmpdir(), "autopilot-env-test-")));
    mkdirSync(join(workspace, ".devcontainer"));
    writeFileSync(join(workspace, ".devcontainer", "devcontainer.json"), JSON.stringify(configuration));
    const calls: string[] = [];
    const start = startEnvironment({ devcontainer: fakeDevcontainer(configuration, services, calls), workspace, idLabel: "x=y", limits, mounts: [], agentFeature: undefined, timeoutMs: 1000, audit: () => {} });
    if (refused) {
      await assert.rejects(start, (error: unknown) => error instanceof EnvironmentRefused && refused.test(error.message));
      assert.deepEqual(calls, []);
      return;
    }
    assert.deepEqual(await start, { kind: "up", containerId: "abc", workspaceFolder: "/workspaces/app" });
    assert.deepEqual(calls, [join(workspace, ".devcontainer", "autopilot.devcontainer.json")]);
    assert.equal(JSON.parse(readFileSync(calls[0] ?? "", "utf8")).remoteUser, "root");
  });
}
