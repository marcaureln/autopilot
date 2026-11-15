import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Ajv2020 } from "ajv/dist/2020.js";
import schema from "../../schema/client.schema.json" with { type: "json" };

export type Client = {
  $schema?: string;
  host: string;
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
  return data;
}
