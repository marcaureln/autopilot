import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Ajv2020 } from "ajv/dist/2020.js";
import schema from "../../schema/client.schema.json" with { type: "json" };

export type Client = {
  $schema?: string;
  hosts: Record<string, string>;
  default_host: string;
  app: { id: number; slug: string };
  owner: string;
};

const CLIENT_PATH = join(homedir(), ".config", "autopilot", "config.json");

const ajv = new Ajv2020({ allErrors: true });
const validate = ajv.compile<Client>(schema);

export function loadClient(path = CLIENT_PATH): Client {
  const data: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!validate(data)) {
    throw new Error(`Invalid client config ${path}: ${ajv.errorsText(validate.errors, { dataVar: "config" })}`);
  }
  if (!data.hosts[data.default_host]) throw new Error(`Invalid client config ${path}: default_host "${data.default_host}" is not in hosts`);
  return data;
}
