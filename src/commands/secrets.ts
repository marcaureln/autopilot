import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_PATH } from "../core/config.ts";
import type { Repo } from "../core/repo.ts";
import { detectRepo } from "../core/repo.ts";
import { itemStored } from "../core/setup.ts";
import type { Audit } from "../core/audit.ts";
import { readRepoSecrets, repoSecretNames, writeRepoSecrets } from "../core/secrets.ts";
import { forward } from "./client.ts";
import {
  assertEnvFileValues,
  envFile,
  parseEnvFile,
  parseOpItem,
  referencedSecrets,
  removeSecretReference,
  SECRET_NAME,
  secretNames,
  secretReference,
  SECRETS_VAULT,
  itemTitle,
  parseSecretsFile,
  setSecretReference,
  withSecrets,
  type OpItem,
} from "../core/repo-secrets.ts";

export type SecretsCommand = { action: "set"; name: string } | { action: "set-from-env"; file: string } | { action: "list" } | { action: "rm"; name: string } | { action: "import" };

// op reads an item from stdin only when stdin is a pipe, and Node gives a child a socket, so a
// shell pipeline feeds it.
export function op(args: string[], input?: string): { ok: boolean; stdout: string; stderr: string } {
  const command: [string, string[]] = input === undefined ? ["op", args] : ["sh", ["-c", 'cat | exec op "$@"', "sh", ...args]];
  const result = spawnSync(command[0], command[1], { input, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
  if (result.error) throw new Error(`op: ${result.error.message}`);
  return { ok: result.status === 0, stdout: result.stdout, stderr: result.stderr.trim() };
}

function ensureOp(): void {
  if (spawnSync("op", ["--version"], { stdio: "ignore" }).error) {
    const install = process.platform === "darwin" ? "brew install 1password-cli" : "see https://developer.1password.com/docs/cli/get-started/";
    throw new Error(`the 1Password CLI (op) is not installed: ${install}`);
  }
  // With the desktop app integration, the first real command asks to unlock; `op whoami` does not.
  let vault = op(["vault", "get", SECRETS_VAULT, "--format", "json"]);
  if (!vault.ok && /not signed in|no accounts/i.test(vault.stderr)) {
    spawnSync("op", ["signin"], { stdio: "inherit" });
    vault = op(["vault", "get", SECRETS_VAULT, "--format", "json"]);
  }
  if (!vault.ok) throw new Error(`op cannot open the vault ${SECRETS_VAULT}: ${vault.stderr}. Create it and give the host's service account read access to it.`);
}

function getItem(repo: Repo): OpItem | undefined {
  const result = op(["item", "get", itemTitle(repo), "--vault", SECRETS_VAULT, "--format", "json"]);
  if (result.ok) return parseOpItem(result.stdout);
  if (/isn't an item/.test(result.stderr)) return undefined;
  throw new Error(`op item get ${itemTitle(repo)}: ${result.stderr}`);
}

function writeValues(repo: Repo, values: Record<string, string>): void {
  assertEnvFileValues(values);
  const item = getItem(repo);
  const json = JSON.stringify(withSecrets(item, repo, values));
  const result = item ? op(["item", "edit", itemTitle(repo), "--vault", SECRETS_VAULT, "--format", "json"], json) : op(["item", "create", "--vault", SECRETS_VAULT, "--format", "json", "-"], json);
  if (!result.ok) throw new Error(`op could not write ${itemTitle(repo)}: ${result.stderr}`);
  const missing = Object.keys(values).filter((name) => !secretNames(parseOpItem(result.stdout)).includes(name));
  if (missing.length > 0) throw new Error(`op did not save ${missing.join(", ")} in ${itemTitle(repo)}`);
}

function originOf(dir: string): Repo | undefined {
  try {
    return detectRepo(dir);
  } catch {
    return undefined;
  }
}

function checkoutConfigOf(repo: Repo): string | undefined {
  const root = spawnSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" });
  if (root.status !== 0) return undefined;
  const top = root.stdout.trim();
  const origin = originOf(top);
  if (!origin || `${origin.owner}/${origin.name}`.toLowerCase() !== `${repo.owner}/${repo.name}`.toLowerCase()) return undefined;
  const path = join(top, CONFIG_PATH);
  return existsSync(path) ? path : undefined;
}

function updateConfig(repo: Repo, edit: (text: string) => string, hint: string): void {
  const path = checkoutConfigOf(repo);
  if (!path) return console.log(`No ${CONFIG_PATH} of ${repo.owner}/${repo.name} in this checkout. ${hint}`);
  writeFileSync(path, edit(readFileSync(path, "utf8")));
  console.log(`Updated ${CONFIG_PATH}: commit it.`);
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

function readHidden(prompt: string): Promise<string> {
  const stdin = process.stdin;
  stdin.setRawMode(true);
  process.stderr.write(prompt);
  stdin.resume();
  stdin.setEncoding("utf8");
  return new Promise((resolve, reject) => {
    let value = "";
    const done = (error?: Error) => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.off("data", onData);
      process.stderr.write("\n");
      if (error) reject(error);
      else resolve(value);
    };
    const onData = (keys: string) => {
      for (const key of keys) {
        if (key === "\r" || key === "\n") return done();
        if (key === "\u0003") return done(new Error("cancelled"));
        if (key === "\u007f" || key === "\b") value = value.slice(0, -1);
        else value += key;
      }
    };
    stdin.on("data", onData);
  });
}

async function readValue(name: string): Promise<string> {
  const value = process.stdin.isTTY ? await readHidden(`Value for ${name} (hidden): `) : (await readStdin()).replace(/\r?\n$/, "");
  if (value.length === 0) throw new Error(`no value for ${name}`);
  return value;
}

async function valuesOf(command: { action: "set"; name: string } | { action: "set-from-env"; file: string }): Promise<Record<string, string>> {
  const values = command.action === "set" ? { [command.name]: await readValue(command.name) } : Object.fromEntries(parseEnvFile(readFileSync(command.file, "utf8")));
  if (Object.keys(values).length === 0) throw new Error(`no secret in ${command.action === "set-from-env" ? command.file : "the input"}`);
  assertEnvFileValues(values);
  return values;
}

// ---- env backend: the values live in the repo's env file on the host ----

// On the client.
export async function sendSecrets(target: string, command: SecretsCommand, repo: Repo): Promise<number> {
  const repoArgs = ["--repo", `${repo.owner}/${repo.name}`];
  switch (command.action) {
    case "set":
    case "set-from-env": {
      const values = await valuesOf(command);
      // A reference in the config wins over the host's file, so a new value there would have no effect.
      const path = checkoutConfigOf(repo);
      const referenced = path ? referencedSecrets(readFileSync(path, "utf8")).filter((name) => Object.hasOwn(values, name)) : [];
      if (referenced.length > 0) throw new Error(`${referenced.join(", ")} is a 1Password reference in ${CONFIG_PATH}: set it with --backend op, or remove the reference first`);
      return forward(target, ["secrets", "import", ...repoArgs], envFile(values));
    }
    case "list":
      return forward(target, ["secrets", "list", ...repoArgs]);
    case "rm":
      return forward(target, ["secrets", "rm", command.name, ...repoArgs]);
    case "import":
      throw new Error("secrets import runs on the host");
  }
}

// On the host, through `sudo autopilot`.
export async function hostSecrets(command: SecretsCommand, repo: Repo, audit: Audit): Promise<void> {
  const name = `${repo.owner}/${repo.name}`;
  const current = () => readRepoSecrets(repo, "secrets: update the repo file", audit);
  switch (command.action) {
    case "import": {
      const values = parseSecretsFile(await readStdin());
      writeRepoSecrets(repo, { ...current(), ...values });
      audit({ event: "secrets.changed", repo: name, action: "set", names: Object.keys(values), by: process.env.SUDO_USER });
      return console.log(`Saved ${Object.keys(values).join(", ")} for ${name} on this host. The next checks get them.`);
    }
    case "rm": {
      const values = current();
      if (!Object.hasOwn(values, command.name)) return console.log(`${name} has no secret ${command.name} on this host.`);
      delete values[command.name];
      writeRepoSecrets(repo, values);
      audit({ event: "secrets.changed", repo: name, action: "rm", names: [command.name], by: process.env.SUDO_USER });
      return console.log(`Removed ${command.name} for ${name}.`);
    }
    case "list": {
      const names = repoSecretNames(repo);
      return console.log(names.length > 0 ? names.join("\n") : `${name} has no secrets on this host.`);
    }
    default:
      throw new Error(`secrets ${command.action} runs on the client: add a host with autopilot hosts add, or pass --host`);
  }
}

// ---- op backend: the values live in 1Password, the references in the repo's config ----

export async function secrets(command: SecretsCommand, repo: Repo): Promise<void> {
  ensureOp();
  switch (command.action) {
    case "import":
      throw new Error("secrets import is for the env backend");
    case "set":
    case "set-from-env": {
      const values = await valuesOf(command);
      const names = Object.keys(values);
      writeValues(repo, values);
      console.log(`Saved ${names.join(", ")} in 1Password (${SECRETS_VAULT}/${itemTitle(repo)}).`);
      const references = names.map((name) => `"${name}": "${secretReference(repo, name)}"`).join(", ");
      updateConfig(repo, (text) => names.reduce((out, name) => setSecretReference(out, name, secretReference(repo, name)), text), `Add to its "secrets": { ${references} }`);
      return;
    }
    case "rm": {
      const item = getItem(repo);
      if (item && secretNames(item).includes(command.name)) {
        const result = op(["item", "edit", itemTitle(repo), "--vault", SECRETS_VAULT, "--format", "json", `${command.name}[delete]`]);
        if (!result.ok) throw new Error(`op could not remove ${command.name}: ${result.stderr}`);
        console.log(`Removed ${command.name} from 1Password.`);
      }
      updateConfig(repo, (text) => removeSecretReference(text, command.name), `Remove "${command.name}" from its "secrets".`);
      return;
    }
    case "list": {
      const stored = secretNames(getItem(repo));
      const path = checkoutConfigOf(repo);
      const referenced = path ? referencedSecrets(readFileSync(path, "utf8")) : [];
      const all = [...new Set([...stored, ...referenced])].toSorted();
      if (all.length === 0) return console.log(`${repo.owner}/${repo.name} has no secrets.`);
      for (const name of all) {
        const where = [stored.includes(name) ? "1Password" : "missing in 1Password", path ? (referenced.includes(name) ? CONFIG_PATH : `missing in ${CONFIG_PATH}`) : undefined];
        console.log(`${name}  ${where.filter(Boolean).join(", ")}`);
      }
      return;
    }
  }
}

export function parseSecretsCommand(positionals: string[], fromEnv: string | undefined): SecretsCommand {
  const [action, name, ...rest] = positionals;
  const usage = "usage: autopilot secrets set <NAME> | set --from-env <file> | list | rm <NAME> [--repo <owner>/<repo>]";
  const checked = (value: string | undefined): string => {
    if (!value) throw new Error(usage);
    if (!SECRET_NAME.test(value)) throw new Error(`"${value}" is not a secret name (A-Z, 0-9 and _)`);
    return value;
  };
  if (action === "set" && rest.length > 0) throw new Error("a value is never an argument: type it at the hidden prompt, pipe it on stdin, or use --from-env <file>");
  if (rest.length > 0) throw new Error(usage);
  if (action === "set" && fromEnv !== undefined && name === undefined) return { action: "set-from-env", file: fromEnv };
  if (action === "set" && fromEnv === undefined) return { action: "set", name: checked(name) };
  if (action === "rm") return { action: "rm", name: checked(name) };
  if (action === "list" && name === undefined) return { action: "list" };
  if (action === "import" && name === undefined) return { action: "import" };
  throw new Error(usage);
}

export function opItemExists(title: string): boolean {
  return itemStored(title, op(["item", "get", title, "--vault", SECRETS_VAULT, "--format", "json"]));
}
