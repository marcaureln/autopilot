import { test } from "node:test";
import assert from "node:assert/strict";
import { composeProblems, devcontainerProblems, dockerfileProblems, imageProblem } from "./devcontainer.ts";

const images: { image: string; problem: boolean }[] = [
  { image: "node:26.13.1", problem: false },
  { image: "mcr.microsoft.com/devcontainers/base:1.2.3-bookworm", problem: false },
  { image: "ghcr.io/example-org/app:2026.11.1", problem: false },
  { image: "postgres:18.1@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef", problem: false },
  { image: "redis@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef", problem: false },
  { image: "localhost:5000/app:1.0", problem: false },
  { image: "node", problem: true },
  { image: "node:latest", problem: true },
  { image: "node:lts", problem: true },
  { image: "localhost:5000/app", problem: true },
  { image: "ubuntu:${VERSION}", problem: true },
];

for (const { image, problem } of images) {
  test(`image ${image} ${problem ? "is refused" : "is accepted"}`, () => {
    assert.equal(imageProblem(image) !== undefined, problem);
  });
}

test("a plain devcontainer with an exact image passes", () => {
  assert.deepEqual(devcontainerProblems({ name: "app", image: "node:26.13.1", postCreateCommand: "npm ci", remoteUser: "node", features: { "ghcr.io/devcontainers/features/go:1": {} } }), []);
});

const refused: { name: string; config: Record<string, unknown>; match: RegExp }[] = [
  { name: "initializeCommand runs on the host", config: { initializeCommand: "curl x | sh" }, match: /initializeCommand/ },
  { name: "runArgs", config: { runArgs: ["--cap-add=NET_ADMIN"] }, match: /runArgs/ },
  { name: "privileged", config: { privileged: true }, match: /privileged/ },
  { name: "capAdd", config: { capAdd: ["SYS_ADMIN"] }, match: /capAdd/ },
  { name: "securityOpt", config: { securityOpt: ["seccomp=unconfined"] }, match: /securityOpt/ },
  { name: "mounts", config: { mounts: ["source=/,target=/host,type=bind"] }, match: /mounts/ },
  { name: "workspaceMount", config: { workspaceMount: "source=/,target=/workspace,type=bind" }, match: /workspaceMount/ },
  { name: "appPort", config: { appPort: 3000 }, match: /appPort/ },
  { name: "a host environment variable", config: { containerEnv: { TOKEN: "${localEnv:GITHUB_TOKEN}" } }, match: /localEnv/ },
  { name: "an image with no version", config: { image: "node" }, match: /node/ },
];

for (const { name, config, match } of refused) {
  test(`devcontainer: ${name} is refused`, () => {
    const problems = devcontainerProblems({ image: "node:26.13.1", ...config });
    assert.equal(problems.length, 1, problems.join("; "));
    assert.match(problems[0] ?? "", match);
  });
}

test("devcontainer: an empty list or false is not a problem", () => {
  assert.deepEqual(devcontainerProblems({ image: "node:26.13.1", capAdd: [], mounts: [], privileged: false, runArgs: [] }), []);
});

const workspace = "/work/repo";

test("compose: an app with the workspace mount and a pinned service passes", () => {
  const compose = {
    services: {
      app: { image: "node:26.13.1", volumes: [{ type: "bind", source: "/work/repo", target: "/workspace" }], command: ["sleep", "infinity"] },
      redis: { image: "redis:8.4", volumes: [{ type: "volume", source: "data", target: "/data" }] },
    },
  };
  assert.deepEqual(composeProblems(compose, workspace), []);
});

const composeRefused: { name: string; service: Record<string, unknown>; match: RegExp }[] = [
  { name: "privileged", service: { privileged: true }, match: /privileged/ },
  { name: "cap_add", service: { cap_add: ["NET_ADMIN"] }, match: /cap_add/ },
  { name: "security_opt", service: { security_opt: ["apparmor=unconfined"] }, match: /security_opt/ },
  { name: "devices", service: { devices: ["/dev/kvm"] }, match: /devices/ },
  { name: "host network", service: { network_mode: "host" }, match: /network_mode/ },
  { name: "host pid", service: { pid: "host" }, match: /pid/ },
  { name: "host ipc", service: { ipc: "host" }, match: /ipc/ },
  { name: "host user namespace", service: { userns_mode: "host" }, match: /userns_mode/ },
  { name: "published ports", service: { ports: [{ target: 5432, published: "5432" }] }, match: /ports/ },
  { name: "a bind mount outside the workspace", service: { volumes: [{ type: "bind", source: "/var/run/docker.sock", target: "/var/run/docker.sock" }] }, match: /docker\.sock/ },
  { name: "a bind mount next to the workspace", service: { volumes: [{ type: "bind", source: "/work/repo-other", target: "/x" }] }, match: /repo-other/ },
  { name: "an image with no version", service: { image: "postgres" }, match: /postgres/ },
];

for (const { name, service, match } of composeRefused) {
  test(`compose: ${name} is refused`, () => {
    const problems = composeProblems({ services: { db: { image: "postgres:18.1", ...service } } }, workspace);
    assert.equal(problems.length, 1, problems.join("; "));
    assert.match(problems[0] ?? "", match);
    assert.match(problems[0] ?? "", /db/);
  });
}

test("compose: a service built from a Dockerfile needs no image", () => {
  assert.deepEqual(composeProblems({ services: { app: { build: { context: "/work/repo/.devcontainer" } } } }, workspace), []);
});

const dockerfiles: { name: string; text: string; problems: number }[] = [
  { name: "a pinned base", text: "FROM node:26.13.1\nRUN npm i -g pnpm@10.0.0\n", problems: 0 },
  { name: "a platform flag and a stage name", text: "FROM --platform=$BUILDPLATFORM golang:1.25.4 AS build\nFROM debian:13.2-slim\nCOPY --from=build /out /out\n", problems: 0 },
  { name: "a later stage from an earlier one", text: "FROM node:26.13.1 AS base\nFROM base\n", problems: 0 },
  { name: "scratch", text: "FROM scratch\n", problems: 0 },
  { name: "an ARG default", text: "ARG VERSION=26.13.1\nFROM node:${VERSION}\n", problems: 0 },
  { name: "an ARG with no default", text: "ARG VERSION\nFROM node:${VERSION}\n", problems: 1 },
  { name: "latest", text: "from node:latest\n", problems: 1 },
  { name: "no tag", text: "FROM ubuntu\nFROM debian\n", problems: 2 },
];

for (const { name, text, problems } of dockerfiles) {
  test(`Dockerfile with ${name} has ${problems} problem(s)`, () => {
    assert.equal(dockerfileProblems(text).length, problems, dockerfileProblems(text).join("; "));
  });
}
