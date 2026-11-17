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

export type HostSecret = "app_key" | "claude_token" | "op_token";

export type HostSecretFile = { secret: HostSecret; path: string };

export const SECRET_LABELS: Record<HostSecret, string> = {
  app_key: "GitHub App key",
  claude_token: "Claude token",
  op_token: "1Password service account token",
};

export function usesOnePassword(secrets: Host["secrets"]): boolean {
  const { api_keys = {}, ...named } = secrets;
  return [...Object.values(named), ...Object.values(api_keys)].some((reference) => reference.startsWith("op://"));
}

export function hostSecretFiles(secrets: Host["secrets"], layout: Pick<Layout, "secretsDir" | "opToken">): HostSecretFile[] {
  const files = (["app_key", "claude_token"] as const).flatMap((secret) => {
    const reference = secrets[secret];
    return reference.startsWith("file:") ? [{ secret, path: `${layout.secretsDir}/${reference.slice("file:".length)}` }] : [];
  });
  return usesOnePassword(secrets) ? [{ secret: "op_token", path: layout.opToken }, ...files] : files;
}

const ajv = new Ajv2020({ allErrors: true, useDefaults: true });
const validate = ajv.compile<Omit<Host, "name"> & { name?: string }>(schema);

export function defaultHostName(): string {
  return (hostname().split(".")[0] ?? "").toLowerCase();
}

export function parseHost(text: string, source: string): Host {
  const data: unknown = JSON.parse(text);
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
