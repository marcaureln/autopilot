import { execFileSync } from "node:child_process";
import { chownSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Audit } from "./audit.ts";
import { LOCAL_LAYOUT } from "./layout.ts";
import type { Repo } from "./repo.ts";
import { envFile, itemTitle, parseSecretsFile } from "./repo-secrets.ts";

const FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

// Values stay in memory, never on disk or in the environment of this process. A reference is
// file:<name>, a file in the host's secrets folder.
export function readSecret(reference: string, reason: string, audit: Audit): string {
  if (reference.startsWith("file:")) {
    const name = reference.slice("file:".length);
    if (!FILE_NAME.test(name)) throw new Error(`${reference} is not file:<name>`);
    const path = join(LOCAL_LAYOUT.secretsDir, name);
    const value = existsSync(path) ? readFileSync(path, "utf8").trim() : "";
    audit({ event: "secret.read", reference, reason, result: value ? "ok" : "failed" });
    if (!value) throw new Error(`the secret file ${path} is missing or empty. From your computer, run autopilot hosts add <name> <target> to push it.`);
    return value;
  }
  throw new Error(`${reference} is not file:<name>`);
}

// ---- Repo secrets: one env file per repo, written by root on a Linux host ----

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
