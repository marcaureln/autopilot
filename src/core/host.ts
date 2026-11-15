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
  installations: string[];
  docker: "rootless" | "rootful";
  poll_interval_seconds: number;
};

export const DEFAULT_HOST_PATH = join(homedir(), ".config", "autopilot", "host.json");

const ajv = new Ajv2020({ allErrors: true, useDefaults: true });
const validate = ajv.compile<Host>(schema);

export function loadHost(path = DEFAULT_HOST_PATH): Host {
  const data: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!validate(data)) {
    throw new Error(`Invalid host file ${path}: ${ajv.errorsText(validate.errors, { dataVar: "host" })}`);
  }
  return data;
}
