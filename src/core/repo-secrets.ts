import type { Repo } from "./repo.ts";

export const SECRET_NAME = /^[A-Z_][A-Z0-9_]*$/;

// GitHub owner names cannot hold an underscore, so the first one splits owner and repo.
export function itemTitle(repo: Repo): string {
  return `${repo.owner}_${repo.name}`.toLowerCase();
}

function unquote(value: string, line: number): string {
  const quote = value[0];
  if (quote !== '"' && quote !== "'") return value.replace(/\s+#.*$/, "").trim();
  const match = quote === '"' ? /^"((?:[^"\\]|\\.)*)"/.exec(value) : /^'([^']*)'/.exec(value);
  if (match?.[1] === undefined) throw new Error(`line ${line}: the quote is not closed`);
  if (quote === "'") return match[1];
  return match[1].replace(/\\(.)/g, (_, char: string) => (char === "n" ? "\n" : char));
}

export function parseEnvFile(text: string): [string, string][] {
  return text.split(/\r?\n/).flatMap((raw, index): [string, string][] => {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) return [];
    const match = /^(?:export\s+)?([^=\s]+)\s*=\s*(.*)$/.exec(line);
    if (!match?.[1] || match[2] === undefined) throw new Error(`line ${index + 1}: no NAME=value`);
    if (!SECRET_NAME.test(match[1])) throw new Error(`line ${index + 1}: "${match[1]}" is not a secret name (A-Z, 0-9 and _)`);
    return [[match[1], unquote(match[2], index + 1)]];
  });
}

// The host's own secrets files: one NAME=value per line, the value exactly as `envFile` wrote it.
// A .env file from a person goes through parseEnvFile instead, which reads quotes and comments.
export function parseSecretsFile(text: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const line of text.split("\n")) {
    if (line === "") continue;
    const at = line.indexOf("=");
    const name = line.slice(0, at);
    if (!SECRET_NAME.test(name)) throw new Error("a line of the secrets file is not NAME=value");
    values[name] = line.slice(at + 1);
  }
  return values;
}

// The docker env file format has no quoting: one NAME=value per line.
export function assertEnvFileValues(secrets: Record<string, string>): void {
  const multiLine = Object.keys(secrets).filter((name) => /[\r\n\0]/.test(secrets[name] ?? ""));
  if (multiLine.length > 0) throw new Error(`the secret ${multiLine.join(", ")} has more than one line, which a docker env file cannot hold`);
}

export function envFile(secrets: Record<string, string>): string {
  assertEnvFileValues(secrets);
  return Object.entries(secrets)
    .map(([name, value]) => `${name}=${value}\n`)
    .join("");
}
