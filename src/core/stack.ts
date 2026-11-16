import packConfig from "../../stacks/node/autopilot.json" with { type: "json" };
import packDevcontainer from "../../stacks/node/devcontainer.json" with { type: "json" };
import packServices from "../../stacks/node/services.json" with { type: "json" };
import { CONFIG_PATH } from "./config.ts";
import { readAgentFile } from "./workspace.ts";

const DEVCONTAINER_PATH = ".devcontainer/devcontainer.json";
const COMPOSE_PATH = ".devcontainer/compose.yaml";

export type RepoFiles = { read(path: string): string | undefined };

export function diskFiles(root: string): RepoFiles {
  return { read: (path) => readAgentFile(root, path, 10 * 1024 * 1024) };
}

type Service = keyof typeof packServices;

export type NodeStack = { manager: "npm" | "pnpm" | "yarn"; commands: Record<string, string>; services: Service[] };

const NPM_DEFAULT_TEST = /no test specified/;

type PackageJson = { scripts: Record<string, string>; dependencies: string[]; pinned: boolean };

function parsePackageJson(text: string): PackageJson {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (error) {
    throw new Error(`package.json is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  const object: Record<string, unknown> = typeof data === "object" && data !== null ? Object.fromEntries(Object.entries(data)) : {};
  const record = (key: string): Record<string, string> => {
    const value = object[key];
    if (typeof value !== "object" || value === null) return {};
    return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
  };
  return {
    scripts: record("scripts"),
    dependencies: [...Object.keys(record("dependencies")), ...Object.keys(record("devDependencies"))],
    pinned: "packageManager" in object || "engines" in object,
  };
}

// The check containers have no network, so only npm is there to run a script.
export function detectNode(files: RepoFiles): NodeStack | undefined {
  const text = files.read("package.json");
  if (text === undefined) return undefined;
  const { scripts, dependencies } = parsePackageJson(text);
  const manager = files.read("pnpm-lock.yaml") !== undefined ? "pnpm" : files.read("yarn.lock") !== undefined ? "yarn" : "npm";
  const types = scripts.typecheck ? "npm run typecheck" : scripts.types ? "npm run types" : files.read("tsconfig.json") !== undefined ? "npx tsc --noEmit" : undefined;
  const commands: Record<string, string> = {
    ...(scripts.lint && { lint: "npm run lint" }),
    ...(types && { types }),
    ...(scripts.test && !NPM_DEFAULT_TEST.test(scripts.test) && { test: "npm test" }),
  };
  const services = (Object.keys(packServices) as Service[]).filter((service) => packServices[service].packages.some((name) => dependencies.includes(name)));
  return { manager, commands, services };
}

type Config = Record<string, unknown> & { verify?: { required?: string[]; commands?: Record<string, string> } & Record<string, unknown> };

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function yamlString(value: string): string {
  return JSON.stringify(value);
}

function composeFile(services: Service[]): string {
  const lines = ["services:", "  app:", `    image: ${yamlString(packDevcontainer.image)}`, `    command: ${yamlString("sleep infinity")}`, "    volumes:", `      - ${yamlString("..:/work")}`];
  for (const name of services) {
    const service = packServices[name];
    lines.push(`  ${name}:`, `    image: ${yamlString(service.image)}`);
    const environment = Object.entries(service.environment);
    if (environment.length > 0) lines.push("    environment:", ...environment.map(([key, value]) => `      ${key}: ${yamlString(value)}`));
  }
  return `${lines.join("\n")}\n`;
}

export function renderOnboarding(files: RepoFiles, stack: NodeStack): Record<string, string> {
  const existingText = files.read(CONFIG_PATH);
  const existing: Config | undefined = existingText === undefined ? undefined : JSON.parse(existingText);
  const base: Config = existing ?? packConfig;
  const required = [...(existing?.verify?.required ?? []), ...Object.keys(stack.commands), ...packConfig.verify.required];
  const config: Config = {
    ...base,
    verify: { ...base.verify, required: [...new Set(required)], commands: { ...stack.commands, ...existing?.verify?.commands } },
  };

  const out: Record<string, string> = { [CONFIG_PATH]: json(config) };
  if (files.read(DEVCONTAINER_PATH) === undefined) {
    if (stack.services.length === 0) out[DEVCONTAINER_PATH] = json(packDevcontainer);
    else {
      out[DEVCONTAINER_PATH] = json({ name: packDevcontainer.name, dockerComposeFile: "compose.yaml", service: "app", workspaceFolder: packDevcontainer.workspaceFolder });
      out[COMPOSE_PATH] = composeFile(stack.services);
    }
  }
  return out;
}

export type ReadinessItem = { section: string; item: string; ok: "yes" | "no" | "by hand" };

function yesNo(ok: boolean): "yes" | "no" {
  return ok ? "yes" : "no";
}

export function readiness(files: RepoFiles, paths: string[]): ReadinessItem[] {
  const has = (path: string) => files.read(path) !== undefined;
  const pkg = files.read("package.json");
  const { scripts, pinned }: Pick<PackageJson, "scripts" | "pinned"> = pkg === undefined ? { scripts: {}, pinned: false } : parsePackageJson(pkg);
  const lockfiles = ["package-lock.json", "pnpm-lock.yaml", "yarn.lock"].filter(has);
  const gitignore = files.read(".gitignore") ?? "";
  return [
    { section: "Environment", item: "A lockfile is committed.", ok: yesNo(lockfiles.length > 0) },
    { section: "Environment", item: "One package manager per repo.", ok: yesNo(lockfiles.length <= 1) },
    { section: "Environment", item: "The runtime version is pinned (`packageManager` or `engines` in package.json).", ok: yesNo(pinned) },
    { section: "Environment", item: "A clean clone installs with no warnings.", ok: "by hand" },
    { section: "Tests and checks", item: "The repo has `lint`, `typecheck`, `test` and `build` scripts.", ok: yesNo(["lint", "typecheck", "test", "build"].every((name) => scripts[name] !== undefined)) },
    { section: "Tests and checks", item: "The tests pass twice in a row on the same commit, and none is marked as flaky.", ok: "by hand" },
    { section: "Tests and checks", item: "CI runs the checks (a workflow in `.github/workflows/`).", ok: yesNo(paths.some((path) => path.startsWith(".github/workflows/"))) },
    { section: "Documentation", item: "The README describes this project, not a starter template.", ok: "by hand" },
    { section: "Documentation", item: "A `.env.example` lists every key the app reads.", ok: yesNo(has(".env.example")) },
    { section: "Documentation", item: "`AGENTS.md` or `CLAUDE.md` exists.", ok: yesNo(has("AGENTS.md") || has("CLAUDE.md")) },
    { section: "Secrets", item: "No `.env` file is tracked in git.", ok: yesNo(!paths.some((path) => /(^|\/)\.env$/.test(path))) },
    { section: "Secrets", item: "`.gitignore` ignores `.env`.", ok: yesNo(/^\/?\.env\*?$/m.test(gitignore)) },
    { section: "Secrets", item: "Any secret that was ever committed is rotated.", ok: "by hand" },
    { section: "Delivery", item: "Deploys run only from the default branch, with human approval for production.", ok: "by hand" },
    { section: "Delivery", item: "Rollback steps are written in the repo.", ok: "by hand" },
  ];
}
