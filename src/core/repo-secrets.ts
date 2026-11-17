import type { Repo } from "./repo.ts";

export const SECRETS_VAULT = "autopilot";

export const SECRET_NAME = /^[A-Z_][A-Z0-9_]*$/;

// GitHub owner names cannot hold an underscore, so the first one splits owner and repo. op also
// finds an item by its website domain; the underscore keeps the title from looking like one.
export function itemTitle(repo: Repo): string {
  return `${repo.owner}_${repo.name}`.toLowerCase();
}

export function secretReference(repo: Repo, name: string): string {
  return `op://${SECRETS_VAULT}/${itemTitle(repo)}/${name}`;
}

// The host's service account reads the whole vault, the host's own items too, and anyone who can
// push to the repo writes its config.
export function refusedSecrets(repo: Repo, secrets: Record<string, string>): string[] {
  return Object.entries(secrets)
    .filter(([name, reference]) => reference !== secretReference(repo, name))
    .map(([name]) => name);
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

type ConfigObject = Record<string, unknown> & { secrets?: Record<string, string> };

function parseObject(text: string): ConfigObject {
  const data: unknown = JSON.parse(text);
  if (typeof data !== "object" || data === null || Array.isArray(data)) throw new Error("the config is not a JSON object");
  return data as ConfigObject;
}

function serialize(config: ConfigObject): string {
  return `${JSON.stringify(config, null, 2)}\n`;
}

export function setSecretReference(text: string, name: string, reference: string): string {
  const config = parseObject(text);
  return serialize({ ...config, secrets: { ...config.secrets, [name]: reference } });
}

export function referencedSecrets(text: string): string[] {
  return Object.keys(parseObject(text).secrets ?? {});
}

export function removeSecretReference(text: string, name: string): string {
  const { secrets = {}, ...rest } = parseObject(text);
  const { [name]: _, ...kept } = secrets;
  return serialize(Object.keys(kept).length > 0 ? { ...rest, secrets: kept } : rest);
}

export type OpField = { id?: string; type?: string; label?: string; value?: string } & Record<string, unknown>;
export type OpItem = { fields?: OpField[] } & Record<string, unknown>;

function isField(value: unknown): value is OpField {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseOpItem(text: string): OpItem {
  const data: unknown = JSON.parse(text);
  if (typeof data !== "object" || data === null || Array.isArray(data)) throw new Error("op printed an item that is not a JSON object");
  const fields: unknown = "fields" in data ? data.fields : [];
  if (!Array.isArray(fields) || !fields.every(isField)) throw new Error("op printed an item with invalid fields");
  return { ...data, fields };
}

export function secretNames(item: unknown): string[] {
  if (typeof item !== "object" || item === null || !("fields" in item) || !Array.isArray(item.fields)) return [];
  return item.fields.filter(isField).flatMap((field) => (field.type === "CONCEALED" && typeof field.label === "string" && SECRET_NAME.test(field.label) ? [field.label] : []));
}

export function withSecrets(item: OpItem | undefined, repo: Repo, values: Record<string, string>): OpItem {
  const base: OpItem = item ?? {
    title: itemTitle(repo),
    category: "SECURE_NOTE",
    fields: [{ id: "notesPlain", type: "STRING", purpose: "NOTES", label: "notesPlain", value: `Runtime secrets for ${repo.owner}/${repo.name}, written by autopilot secrets.` }],
  };
  const fields = base.fields ?? [];
  const updated = fields.map((field) => (field.label !== undefined && Object.hasOwn(values, field.label) ? { ...field, value: values[field.label] } : field));
  const added = Object.entries(values)
    .filter(([name]) => !fields.some((field) => field.label === name))
    .map(([name, value]) => ({ id: name, type: "CONCEALED", label: name, value }));
  return { ...base, fields: [...updated, ...added] };
}
