import { readFileSync } from "node:fs";
import { hostname } from "node:os";
import { Ajv2020 } from "ajv/dist/2020.js";
import schema from "../../schema/host.schema.json" with { type: "json" };

export type Host = {
  $schema?: string;
  name: string;
  app_id: number;
  secrets: { app_key: string; claude_token: string };
  owners: string[];
  allow: string[];
  docker: "rootless" | "rootful";
  poll_interval_seconds: number;
  limits: { memory: string; cpus: number; pids: number };
  claude?: { config?: string };
};

export type ClaudeConfigSource = { kind: "path"; path: string } | { kind: "github"; owner: string; repo: string; subdir?: string; ref?: string };

export const HOST_FILE = "/etc/autopilot/host.json";

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
  return parseHost(readFileSync(path, "utf8"), path);
}

const GITHUB_SOURCE = /^github\.com\/([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+)(?:\/\/([^#]+))?(?:#(.+))?$/;

export function parseClaudeConfigSource(value: string): ClaudeConfigSource {
  if (value.startsWith("/")) return { kind: "path", path: value };
  const match = GITHUB_SOURCE.exec(value);
  const [, owner, repo, subdir, ref] = match ?? [];
  if (!owner || !repo || subdir?.split("/").includes("..")) {
    throw new Error(`claude.config "${value}" must be github.com/<owner>/<repo>[//<subdir>][#<ref>] or an absolute path`);
  }
  return { kind: "github", owner, repo, ...(subdir && { subdir }), ...(ref && { ref }) };
}
