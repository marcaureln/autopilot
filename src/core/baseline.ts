import { Ajv2020 } from "ajv/dist/2020.js";

export const BASELINE_PATH = ".github/autopilot-baseline.json";

export type Baseline = Record<string, string[]>;

const ajv = new Ajv2020({ allErrors: true });
const validate = ajv.compile<{ version: 1; checks: Baseline }>({
  type: "object",
  required: ["version", "checks"],
  properties: {
    version: { const: 1 },
    checks: { type: "object", additionalProperties: { type: "array", items: { type: "string" } } },
  },
});

const LINE_COLUMN = /\b\d+:\d+\b/g;
const TSC_POSITION = /\(\d+,\d+\)/g;
const FILE_LINE = /(\.\w+):\d+\b/g;
const SUMMARY = /^\W*(found\s+)?\d+\s+(problems?|errors?|warnings?)\b/i;

export function knownFailureLines(output: string): string[] {
  return output
    .replace(/\u001b\[[0-9;]*m/g, "")
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter((line) => line.length > 0 && !SUMMARY.test(line))
    .map((line) => line.replace(LINE_COLUMN, "#:#").replace(TSC_POSITION, "(#,#)").replace(FILE_LINE, "$1:#"));
}

export function newFailures(output: string, baseline: string[]): string[] {
  const lines = knownFailureLines(output);
  if (lines.length === 0) return ["(the check failed with no output)"];
  const left = new Map<string, number>();
  for (const line of baseline) left.set(line, (left.get(line) ?? 0) + 1);
  return lines.filter((line) => {
    const count = left.get(line) ?? 0;
    left.set(line, count - 1);
    return count <= 0;
  });
}

export function parseBaseline(text: string): Baseline {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (error) {
    throw new Error(`${BASELINE_PATH} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!validate(data)) throw new Error(`invalid ${BASELINE_PATH}: ${ajv.errorsText(validate.errors, { dataVar: "baseline" })}`);
  return data.checks;
}

export function renderBaseline(checks: Baseline): string {
  return `${JSON.stringify({ version: 1, checks }, null, 2)}\n`;
}
