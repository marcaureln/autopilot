import { test } from "node:test";
import assert from "node:assert/strict";
import { detectNode, readiness, renderOnboarding, type RepoFiles } from "./stack.ts";

function files(entries: Record<string, string>): RepoFiles {
  return { read: (path) => entries[path] };
}

const pkg = (body: object) => JSON.stringify(body);
const NPM_DEFAULT_TEST = 'echo "Error: no test specified" && exit 1';

const detectCases: { name: string; entries: Record<string, string>; expected: ReturnType<typeof detectNode> }[] = [
  { name: "no package.json", entries: { "README.md": "" }, expected: undefined },
  {
    name: "npm with lint, typecheck and test scripts",
    entries: { "package.json": pkg({ scripts: { lint: "eslint .", typecheck: "tsc", test: "vitest run" } }), "package-lock.json": "" },
    expected: { manager: "npm", commands: { lint: "npm run lint", types: "npm run typecheck", test: "npm test" }, services: [] },
  },
  {
    name: "pnpm with a types script and no lint",
    entries: { "package.json": pkg({ scripts: { types: "tsc", test: "node --test" } }), "pnpm-lock.yaml": "" },
    expected: { manager: "pnpm", commands: { types: "npm run types", test: "npm test" }, services: [] },
  },
  {
    name: "yarn with a tsconfig and the npm default test",
    entries: { "package.json": pkg({ scripts: { test: NPM_DEFAULT_TEST } }), "yarn.lock": "", "tsconfig.json": "{}" },
    expected: { manager: "yarn", commands: { types: "npx tsc --noEmit" }, services: [] },
  },
  {
    name: "services from the dependencies",
    entries: { "package.json": pkg({ dependencies: { pg: "8", ioredis: "5" }, devDependencies: { "@prisma/client": "6" } }) },
    expected: { manager: "npm", commands: {}, services: ["postgres", "redis"] },
  },
];

for (const { name, entries, expected } of detectCases) {
  test(`detect: ${name}`, () => {
    assert.deepEqual(detectNode(files(entries)), expected);
  });
}

test("detect: a package.json that is not JSON is an error", () => {
  assert.throws(() => detectNode(files({ "package.json": "{" })), /package\.json/);
});

const stack = { manager: "npm" as const, commands: { lint: "npm run lint", test: "npm test" }, services: [] };

test("render: a new repo gets the pack config with the detected checks first", () => {
  const out = renderOnboarding(files({}), stack);
  const config = JSON.parse(out[".github/autopilot.json"] ?? "");
  assert.deepEqual(config.verify, { required: ["lint", "test", "sast", "deps-scan", "secrets-scan"], commands: { lint: "npm run lint", test: "npm test" } });
  assert.equal(config.merge, "manual");
  assert.deepEqual(JSON.parse(out[".devcontainer/devcontainer.json"] ?? ""), { name: "node", image: "node:26.13.1", workspaceFolder: "/work" });
  assert.equal(out[".devcontainer/compose.yaml"], undefined);
});

test("render: an existing config keeps its fields and its commands, and gains the missing checks", () => {
  const existing = { version: 1, stack: ["node"], merge: "auto", verify: { required: ["lint", "sast"], commands: { lint: "test -s README.md" } }, secrets: { A: "op://autopilot/o_r/A" } };
  const config = JSON.parse(renderOnboarding(files({ ".github/autopilot.json": JSON.stringify(existing) }), stack)[".github/autopilot.json"] ?? "");
  assert.equal(config.merge, "auto");
  assert.deepEqual(config.secrets, existing.secrets);
  assert.deepEqual(config.verify, { required: ["lint", "sast", "test", "deps-scan", "secrets-scan"], commands: { lint: "test -s README.md", test: "npm test" } });
});

test("render: an existing devcontainer is left alone", () => {
  const out = renderOnboarding(files({ ".devcontainer/devcontainer.json": "{}" }), stack);
  assert.equal(out[".devcontainer/devcontainer.json"], undefined);
});

test("render: services go to a compose file that the devcontainer uses", () => {
  const out = renderOnboarding(files({}), { ...stack, services: ["postgres"] });
  assert.deepEqual(JSON.parse(out[".devcontainer/devcontainer.json"] ?? ""), {
    name: "node",
    dockerComposeFile: "compose.yaml",
    service: "app",
    workspaceFolder: "/work",
  });
  assert.equal(
    out[".devcontainer/compose.yaml"],
    `services:
  app:
    image: "node:26.13.1"
    command: "sleep infinity"
    volumes:
      - "..:/work"
  postgres:
    image: "postgres:18.1"
    environment:
      POSTGRES_USER: "app"
      POSTGRES_PASSWORD: "app"
      POSTGRES_DB: "app"
`,
  );
});

const readinessCases: { name: string; entries: Record<string, string>; failing: string[] }[] = [
  {
    name: "a ready repo",
    entries: {
      "package.json": pkg({ packageManager: "pnpm@10", scripts: { lint: "x", typecheck: "x", test: "x", build: "x" } }),
      "pnpm-lock.yaml": "",
      "AGENTS.md": "",
      ".env.example": "",
      ".gitignore": "node_modules\n.env\n",
      ".github/workflows/ci.yml": "",
    },
    failing: [],
  },
  {
    name: "a bare repo",
    entries: { "package.json": pkg({}), "package-lock.json": "", "yarn.lock": "", ".env": "A=1" },
    failing: [
      "One package manager per repo.",
      "The runtime version is pinned (`packageManager` or `engines` in package.json).",
      "The repo has `lint`, `typecheck`, `test` and `build` scripts.",
      "CI runs the checks (a workflow in `.github/workflows/`).",
      "A `.env.example` lists every key the app reads.",
      "`AGENTS.md` or `CLAUDE.md` exists.",
      "No `.env` file is tracked in git.",
      "`.gitignore` ignores `.env`.",
    ],
  },
];

for (const { name, entries, failing } of readinessCases) {
  test(`readiness: ${name}`, () => {
    const items = readiness(files(entries), Object.keys(entries));
    assert.deepEqual(
      items.filter((item) => item.ok === "no").map((item) => item.item),
      failing,
    );
    assert.ok(items.some((item) => item.ok === "by hand"), "some items need a person");
  });
}
