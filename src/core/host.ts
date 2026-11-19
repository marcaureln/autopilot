import { readFileSync } from "node:fs";
import { hostname } from "node:os";
import { Ajv2020 } from "ajv/dist/2020.js";
import schema from "../../schema/host.schema.json" with { type: "json" };
import { LOCAL_LAYOUT, type Layout } from "./layout.ts";

export type Host = {
  $schema?: string;
  name: string;
  app_id: number;
  secrets: { app_key: string; claude_token: string; api_keys?: Record<string, string> };
  owners: string[];
  allow: string[];
  docker: "rootless" | "rootful";
  poll_interval_seconds: number;
  concurrency: number;
  limits: { memory: string; cpus: number; pids: number };
  claude?: { config?: string };
};

export type Source = { kind: "path"; path: string } | { kind: "github"; owner: string; repo: string; subdir?: string; ref?: string };

export const HOST_FILE = LOCAL_LAYOUT.hostFile;

export const API_KEY_PREFIX = "api_key:";

export type HostSecret = "app_key" | "claude_token" | `${typeof API_KEY_PREFIX}${string}`;

export type HostSecretFile = { secret: HostSecret; path: string };

export function secretLabel(secret: HostSecret): string {
  if (secret === "app_key") return "GitHub App key";
  if (secret === "claude_token") return "Claude token";
  return `API key ${secret.slice(API_KEY_PREFIX.length)}`;
}

// Same pattern as the property names of secrets.api_keys in the host schema.
export const API_KEY_NAME = /^[A-Z][A-Z0-9_]*$/;

// Returns the text itself when nothing changes.
export function addApiKeys(text: string, names: string[]): string {
  const data: { secrets: { api_keys?: Record<string, string> } } = JSON.parse(text);
  const missing = names.filter((name) => !Object.hasOwn(data.secrets.api_keys ?? {}, name));
  if (missing.length === 0) return text;
  data.secrets.api_keys = { ...data.secrets.api_keys, ...Object.fromEntries(missing.map((name) => [name, `file:${name.toLowerCase()}`])) };
  return JSON.stringify(data, null, 2) + "\n";
}

export function hostSecretFiles(secrets: Host["secrets"], layout: Pick<Layout, "secretsDir">): HostSecretFile[] {
  const fileOf = (secret: HostSecret, reference: string): HostSecretFile[] =>
    reference.startsWith("file:") ? [{ secret, path: `${layout.secretsDir}/${reference.slice("file:".length)}` }] : [];
  return [
    ...fileOf("app_key", secrets.app_key),
    ...fileOf("claude_token", secrets.claude_token),
    ...Object.entries(secrets.api_keys ?? {}).flatMap(([name, reference]) => fileOf(`${API_KEY_PREFIX}${name}`, reference)),
  ];
}

const ajv = new Ajv2020({ allErrors: true, useDefaults: true });
const validate = ajv.compile<Omit<Host, "name"> & { name?: string }>(schema);

export function defaultHostName(): string {
  return (hostname().split(".")[0] ?? "").toLowerCase();
}

// Names the fields, never their values.
function onePasswordFields(data: unknown): string[] {
  const secrets = typeof data === "object" && data !== null && "secrets" in data ? data.secrets : undefined;
  if (typeof secrets !== "object" || secrets === null) return [];
  const isOp = (value: unknown): boolean => typeof value === "string" && value.startsWith("op://");
  const apiKeys = "api_keys" in secrets && typeof secrets.api_keys === "object" && secrets.api_keys !== null ? secrets.api_keys : {};
  return [
    ...(["app_key", "claude_token"] as const).filter((field) => field in secrets && isOp((secrets as Record<string, unknown>)[field])).map((field) => `secrets.${field}`),
    ...Object.entries(apiKeys).filter(([, value]) => isOp(value)).map(([name]) => `secrets.api_keys.${name}`),
  ];
}

export function parseHost(text: string, source: string): Host {
  const data: unknown = JSON.parse(text);
  const refused = onePasswordFields(data);
  if (refused.length > 0) {
    throw new Error(
      `Invalid host file ${source}: ${refused.join(", ")} is a 1Password reference, and 1Password is no longer supported. ` +
        `Set each secret again with the file backend: in the host file, use "file:app-key.pem" for app_key, "file:claude-token" for claude_token and "file:<name>" for an API key. ` +
        `Then, from your computer, run autopilot hosts add <name> <target> to push the App key and the Claude token. Put an API key file in the host's secrets folder.`,
    );
  }
  if (!validate(data)) {
    throw new Error(`Invalid host file ${source}: ${ajv.errorsText(validate.errors, { dataVar: "host" })}`);
  }
  return { ...data, name: data.name ?? defaultHostName() };
}

export function loadHost(path = HOST_FILE): Host {
  try {
    return parseHost(readFileSync(path, "utf8"), path);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`The host file ${path} is missing or not valid: ${reason}. Fix it, then run \`autopilot start\`.`, { cause: error });
  }
}

const GITHUB_SOURCE = /^github\.com\/([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+)(?:\/\/([^#]+))?(?:#(.+))?$/;

export function parseSource(value: string, field = "claude.config"): Source {
  if (value.startsWith("/")) return { kind: "path", path: value };
  const match = GITHUB_SOURCE.exec(value);
  const [, owner, repo, subdir, ref] = match ?? [];
  if (!owner || !repo || subdir?.split("/").includes("..")) {
    throw new Error(`${field} "${value}" must be github.com/<owner>/<repo>[//<subdir>][#<ref>] or an absolute path`);
  }
  return { kind: "github", owner, repo, ...(subdir && { subdir }), ...(ref && { ref }) };
}
