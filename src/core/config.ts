import { Ajv2020 } from "ajv/dist/2020.js";
import schema from "../../schema/autopilot.schema.json" with { type: "json" };

export type Role = "planner" | "builder";

export type Agent = {
  harness: "claude";
  model: string;
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
};

export type Config = {
  $schema?: string;
  version: 1;
  stack: "node"[];
  agents: Record<Role, Agent>;
  steps: Record<"spec" | "build" | "fix", Role>;
  skills: Record<Role, string[]>;
  verify: {
    mode: "local" | "remote";
    required: string[];
    commands: Record<string, string>;
    timeout_minutes: number;
  };
  preview?: { command: string; url: string };
  merge: "auto" | "manual";
  risk: { high_paths: string[]; max_diff_lines: number };
  secrets: Record<string, string>;
  limits: { fix_rounds: number; run_timeout_minutes: number };
};

const ajv = new Ajv2020({ allErrors: true, useDefaults: true });
const validate = ajv.compile<Config>(schema);

export function parseConfig(text: string, source: string): Config {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (error) {
    throw new Error(`Invalid config ${source}: ${error instanceof Error ? error.message : error}`);
  }
  if (!validate(data)) {
    throw new Error(`Invalid config ${source}: ${ajv.errorsText(validate.errors, { dataVar: "config" })}`);
  }
  return data;
}
