import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Audit } from "./audit.ts";

const OP_TOKEN_FILE = "/etc/autopilot/op-token";

// systemd LoadCredential= sets CREDENTIALS_DIRECTORY for the service. Without a token file (a dev
// machine), op uses its own sign-in.
function opTokenFile(): string | undefined {
  const credentials = process.env.CREDENTIALS_DIRECTORY;
  if (credentials) return join(credentials, "op-token");
  return existsSync(OP_TOKEN_FILE) ? OP_TOKEN_FILE : undefined;
}

// Values stay in memory, never on disk or in the environment of this process.
export function readSecret(reference: string, reason: string, audit: Audit): string {
  const tokenFile = opTokenFile();
  const env = tokenFile ? { ...process.env, OP_SERVICE_ACCOUNT_TOKEN: readFileSync(tokenFile, "utf8").trim() } : process.env;
  const result = spawnSync("op", ["read", "--no-newline", reference], { encoding: "utf8", env, stdio: ["ignore", "pipe", "pipe"] });
  const ok = result.status === 0 && result.stdout.length > 0;
  audit({ event: "secret.read", reference, reason, result: ok ? "ok" : "failed" });
  if (!ok) throw new Error(`op read ${reference} failed: ${result.error?.message ?? result.stderr.trim()}`);
  return result.stdout;
}
