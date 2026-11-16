import type { Repo } from "./repo.ts";

export const SECRETS_VAULT = "autopilot";

// GitHub owner names cannot hold an underscore, so the first one splits owner and repo. op also
// finds an item by its website domain; the underscore keeps the title from looking like one.
export function itemTitle(repo: Repo): string {
  return `${repo.owner}_${repo.name}`.toLowerCase();
}

export function secretReference(repo: Repo, name: string): string {
  return `op://${SECRETS_VAULT}/${itemTitle(repo)}/${name}`;
}

// The host's service account can read the whole vault, the host's own items included. A repo
// config is written by anyone who can push to the repo, so it gets only its own item, through the
// exact reference that `autopilot secrets set` writes.
export function refusedSecrets(repo: Repo, secrets: Record<string, string>): string[] {
  return Object.entries(secrets)
    .filter(([name, reference]) => reference !== secretReference(repo, name))
    .map(([name]) => name);
}

// The docker env file format has no quoting: one NAME=value per line.
export function envFile(secrets: Record<string, string>): string {
  return Object.entries(secrets)
    .map(([name, value]) => {
      if (/[\r\n\0]/.test(value)) throw new Error(`the secret ${name} has more than one line, which a docker env file cannot hold`);
      return `${name}=${value}\n`;
    })
    .join("");
}
