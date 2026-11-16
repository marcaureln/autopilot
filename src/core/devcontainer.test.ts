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
  { name: "a host environment variable with env", config: { containerEnv: { TOKEN: "${env:GITHUB_TOKEN}" } }, match: /TOKEN/ },
  { name: "a build cache from a host path", config: { build: { dockerfile: "Dockerfile", cacheFrom: "type=local,src=/home/user" } }, match: /cacheFrom/ },
  { name: "build options", config: { build: { dockerfile: "Dockerfile", options: ["--network=host"] } }, match: /build\.options/ },
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
// /work/repo/link is a symlink to /, and /work/repo/missing does not exist.
const resolve = (path: string) => (path.startsWith("/work/repo/missing") ? undefined : path.replace(/^\/work\/repo\/link(\/|$)/, "/"));

test("compose: an app with the workspace mount and a pinned service passes", () => {
  const compose = {
    services: {
      app: { image: "node:26.13.1", volumes: [{ type: "bind", source: "/work/repo", target: "/workspace" }], command: ["sleep", "infinity"] },
      redis: { image: "redis:8.4", volumes: [{ type: "volume", source: "data", target: "/data" }] },
    },
  };
  assert.deepEqual(composeProblems(compose, workspace, resolve), []);
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
  { name: "a bind mount through a symlink to the host", service: { volumes: [{ type: "bind", source: "/work/repo/link/etc", target: "/x" }] }, match: /link\/etc/ },
  { name: "a bind mount that does not exist", service: { volumes: [{ type: "bind", source: "/work/repo/missing", target: "/x" }] }, match: /missing/ },
  { name: "volumes_from", service: { volumes_from: ["container:other"] }, match: /volumes_from/ },
  { name: "the network of another container", service: { network_mode: "container:other" }, match: /network_mode: container:other/ },
  { name: "the pid namespace of another container", service: { pid: "container:other" }, match: /pid/ },
  { name: "host uts", service: { uts: "host" }, match: /uts/ },
  { name: "a runtime", service: { runtime: "runc" }, match: /runtime/ },
  { name: "cgroup_parent", service: { cgroup_parent: "/" }, match: /cgroup_parent/ },
  { name: "device_cgroup_rules", service: { device_cgroup_rules: ["c 1:3 mr"] }, match: /device_cgroup_rules/ },
  { name: "an env_file outside the repo", service: { env_file: [{ path: "/etc/autopilot/env", required: true }] }, match: /env_file/ },
  { name: "a build context outside the repo", service: { image: undefined, build: { context: "/home/user" } }, match: /build context/ },
  { name: "a build context through a symlink", service: { image: undefined, build: { context: "/work/repo/link" } }, match: /build context/ },
  { name: "a build with the ssh agent", service: { image: undefined, build: { context: "/work/repo", ssh: ["default"] } }, match: /build\.ssh/ },
  { name: "a build with more contexts", service: { image: undefined, build: { context: "/work/repo", additional_contexts: { host: "/" } } }, match: /additional_contexts/ },
  { name: "a build on the host network", service: { image: undefined, build: { context: "/work/repo", network: "host" } }, match: /build\.network/ },
  { name: "a build cache in a host path", service: { image: undefined, build: { context: "/work/repo", cache_to: ["type=local,dest=/home/user"] } }, match: /build\.cache_to/ },
  { name: "a privileged build", service: { image: undefined, build: { context: "/work/repo", privileged: true } }, match: /build\.privileged/ },
  { name: "a build that tags an image of the host", service: { image: "autopilot-claude:0123456789ab", build: { context: "/work/repo" } }, match: /cannot set `image`/ },
];

for (const { name, service, match } of composeRefused) {
  test(`compose: ${name} is refused`, () => {
    const problems = composeProblems({ services: { db: { image: "postgres:18.1", ...service } } }, workspace, resolve);
    assert.equal(problems.length, 1, problems.join("; "));
    assert.match(problems[0] ?? "", match);
    assert.match(problems[0] ?? "", /db/);
  });
}

test("compose: a service in the network of another service of the project passes", () => {
  assert.deepEqual(composeProblems({ services: { app: { image: "node:26.13.1" }, sidecar: { image: "redis:8.4", network_mode: "service:app", env_file: ["/work/repo/.env", { path: "/work/repo/missing.env", required: false }] } } }, workspace, resolve), []);
});

const topLevel: { name: string; compose: Record<string, unknown>; match: RegExp | undefined }[] = [
  { name: "a plain named volume", compose: { name: "app", volumes: { data: { name: "app_data" } } }, match: undefined },
  { name: "a volume with a custom name", compose: { name: "app", volumes: { data: { name: "grype-db" } } }, match: /volume data: a custom name/ },
  { name: "a plain network", compose: { name: "app", networks: { backend: { name: "app_backend", ipam: {} } } }, match: undefined },
  { name: "an external network", compose: { name: "app", networks: { outside: { name: "app_outside", external: true } } }, match: /network outside: `external`/ },
  { name: "a network with a custom name", compose: { name: "app", networks: { backend: { name: "bridge" } } }, match: /network backend: a custom name/ },
  { name: "a network with another driver", compose: { name: "app", networks: { backend: { name: "app_backend", driver: "macvlan" } } }, match: /network backend: only the bridge driver/ },
  { name: "a volume with no fields", compose: { volumes: { data: null } }, match: undefined },
  { name: "a volume that binds a host path", compose: { volumes: { data: { driver: "local", driver_opts: { type: "none", o: "bind", device: "/" } } } }, match: /volume data/ },
  { name: "an external volume", compose: { volumes: { data: { external: true } } }, match: /volume data/ },
  { name: "a volume with another driver", compose: { volumes: { data: { driver: "sshfs" } } }, match: /volume data/ },
  { name: "a secret file in the repo", compose: { secrets: { key: { file: "/work/repo/.devcontainer/key" } } }, match: undefined },
  { name: "inline config content", compose: { configs: { conf: { content: "a=1" } } }, match: undefined },
  { name: "a secret file outside the repo", compose: { secrets: { key: { file: "/home/user/.ssh/id_ed25519" } } }, match: /secrets key/ },
  { name: "a secret from a host variable", compose: { secrets: { key: { environment: "HOME" } } }, match: /secrets key/ },
  { name: "a config file through a symlink", compose: { configs: { conf: { file: "/work/repo/link/etc/shadow" } } }, match: /configs conf/ },
];

for (const { name, compose, match } of topLevel) {
  test(`compose: ${name} ${match ? "is refused" : "passes"}`, () => {
    const problems = composeProblems(compose, workspace, resolve);
    if (!match) return assert.deepEqual(problems, []);
    assert.equal(problems.length, 1, problems.join("; "));
    assert.match(problems[0] ?? "", match);
  });
}

test("compose: a service built from a Dockerfile needs no image", () => {
  assert.deepEqual(composeProblems({ services: { app: { build: { context: "/work/repo/.devcontainer" } } } }, workspace, resolve), []);
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
