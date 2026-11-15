import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Ajv2020 } from "ajv/dist/2020.js";
import schema from "../../schema/host.schema.json" with { type: "json" };

export type Host = {
  $schema?: string;
  app_id: number;
  private_key_path: string;
  owners: string[];
  allow: string[];
  docker: "rootless" | "rootful";
  poll_interval_seconds: number;
};

export const DEFAULT_HOST_PATH = join(homedir(), ".config", "autopilot", "host.json");

const ajv = new Ajv2020({ allErrors: true, useDefaults: true });
const validate = ajv.compile<Host>(schema);

export function parseHost(text: string, source: string): Host {
  const data: unknown = JSON.parse(text);
  if (!validate(data)) {
    throw new Error(`Invalid host file ${source}: ${ajv.errorsText(validate.errors, { dataVar: "host" })}`);
  }
  return data;
}

export function loadHost(path = DEFAULT_HOST_PATH): Host {
  return parseHost(readFileSync(path, "utf8"), path);
}
