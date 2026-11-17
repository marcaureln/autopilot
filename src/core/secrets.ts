import { execFileSync, spawnSync } from "node:child_process";
import { chownSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Audit } from "./audit.ts";
import { LOCAL_LAYOUT } from "./layout.ts";
import type { Repo } from "./repo.ts";
import { envFile, itemTitle, parseSecretsFile } from "./repo-secrets.ts";

const OP_TOKEN_FILE = LOCAL_LAYOUT.opToken;

// systemd LoadCredential= sets CREDENTIALS_DIRECTORY for the service. Without a token file (a dev
// machine), op uses its own sign-in.
function opTokenFile(): string | undefined {
  const credentials = process.env.CREDENTIALS_DIRECTORY;
  if (credentials) return join(credentials, "op-token");
  return existsSync(OP_TOKEN_FILE) ? OP_TOKEN_FILE : undefined;
}

const FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

// Values stay in memory, never on disk or in the environment of this process. A reference is
// op://<vault>/<item>/<field> (1Password) or file:<name> (a file in the host's secrets folder).
export function readSecret(reference: string, reason: string, audit: Audit): string {
  if (reference.startsWith("file:")) {
    const name = reference.slice("file:".length);
    if (!FILE_NAME.test(name)) throw new Error(`${reference} is not file:<name>`);
    const path = join(LOCAL_LAYOUT.secretsDir, name);
    const value = existsSync(path) ? readFileSync(path, "utf8").trim() : "";
    audit({ event: "secret.read", reference, reason, result: value ? "ok" : "failed" });
    if (!value) throw new Error(`the secret file ${path} is missing or empty`);
    return value;
  }
  const tokenFile = opTokenFile();
  const env = tokenFile ? { ...process.env, OP_SERVICE_ACCOUNT_TOKEN: readFileSync(tokenFile, "utf8").trim() } : process.env;
  const result = spawnSync("op", ["read", "--no-newline", reference], { encoding: "utf8", env, stdio: ["ignore", "pipe", "pipe"] });
  const ok = result.status === 0 && result.stdout.length > 0;
  audit({ event: "secret.read", reference, reason, result: ok ? "ok" : "failed" });
  if (!ok) throw new Error(`op read ${reference} failed: ${result.error?.message ?? result.stderr.trim()}`);
  return result.stdout;
}

// ---- Repo secrets of the env backend: one env file per repo, written by root on a Linux host ----

function repoFile(repo: Repo): string {
  return join(LOCAL_LAYOUT.secretsDir, "repos", `${itemTitle(repo)}.env`);
}

function readRepoFile(repo: Repo): Record<string, string> | undefined {
  try {
    return parseSecretsFile(readFileSync(repoFile(repo), "utf8"));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  }
}

export function readRepoSecrets(repo: Repo, reason: string, audit: Audit): Record<string, string> {
  const values = readRepoFile(repo);
  if (values) audit({ event: "secret.read", reference: `file:repos/${itemTitle(repo)}.env`, reason, result: "ok" });
  return values ?? {};
}

export function repoSecretNames(repo: Repo): string[] {
  return Object.keys(readRepoFile(repo) ?? {});
}

// Root writes the file through `sudo autopilot`; the service user reads it through the group. A
// tmp name of its own, created new, so a file left by a crash cannot give the secrets its mode.
export function writeRepoSecrets(repo: Repo, values: Record<string, string>): void {
  const path = repoFile(repo);
  const tmp = `${path}.${process.pid}.tmp`;
  mkdirSync(join(LOCAL_LAYOUT.secretsDir, "repos"), { recursive: true, mode: 0o750 });
  const linux = LOCAL_LAYOUT.os === "linux";
  writeFileSync(tmp, envFile(values), { mode: linux ? 0o640 : 0o600, flag: "wx" });
  if (linux) chownSync(tmp, 0, Number(execFileSync("id", ["-g", "autopilot"], { encoding: "utf8" }).trim()));
  renameSync(tmp, path);
}
