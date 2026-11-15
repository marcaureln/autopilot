import { basename, matchesGlob } from "node:path";
import type { Config } from "./config.ts";

export type Risk = "low" | "high";

export type FileChange =
  | { status: "added" | "modified" | "deleted"; path: string; additions: number; deletions: number }
  | { status: "renamed"; path: string; previousPath: string; additions: number; deletions: number };

const LOCKFILES = new Set([
  "package-lock.json",
  "npm-shrinkwrap.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "bun.lock",
  "bun.lockb",
  "go.sum",
  "Cargo.lock",
  "poetry.lock",
  "uv.lock",
  "Pipfile.lock",
  "Gemfile.lock",
  "composer.lock",
]);

const SENSITIVE_WORDS = new Set([
  "auth",
  "oauth",
  "login",
  "session",
  "token",
  "password",
  "secret",
  "crypto",
  "security",
  "permission",
  "acl",
  "rbac",
  "payment",
  "billing",
  "invoice",
  "checkout",
  "subscription",
  "stripe",
]);

function words(path: string): string[] {
  return path
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[/.\-_\s]+/);
}

function isSensitiveWord(word: string): boolean {
  return SENSITIVE_WORDS.has(word) || (word.endsWith("s") && SENSITIVE_WORDS.has(word.slice(0, -1)));
}

const ALWAYS_HIGH: ((path: string, name: string) => boolean)[] = [
  (path) => matchesGlob(path, ".github/**") || matchesGlob(path, ".devcontainer/**"),
  (_, name) => name === "AGENTS.md",
  (_, name) => LOCKFILES.has(name),
  (path) => path.split("/").some((dir) => dir === "migrations" || dir === "migrate"),
  (path) => words(path).some(isSensitiveWord),
  (_, name) => /\.(tf|tfvars)$/.test(name) || name.startsWith("Dockerfile") || /\.Dockerfile$/i.test(name),
  (_, name) => /^(docker-)?compose(\..+)?\.ya?ml$/.test(name),
  (_, name) => name.startsWith(".env"),
  (_, name) => /\.config\./.test(name) || /^tsconfig.*\.json$/.test(name) || /^\.[a-z]+rc(\..+)?$/.test(name),
];

function isHighPath(path: string, highPaths: string[]): boolean {
  const name = basename(path);
  return ALWAYS_HIGH.some((rule) => rule(path, name)) || highPaths.some((glob) => matchesGlob(path, glob));
}

export function assessRisk(changes: FileChange[], risk: Config["risk"]): Risk {
  const lines = changes.reduce((sum, change) => sum + change.additions + change.deletions, 0);
  const high =
    lines > risk.max_diff_lines ||
    changes.some(
      (change) =>
        change.status === "deleted" ||
        isHighPath(change.path, risk.high_paths) ||
        (change.status === "renamed" && isHighPath(change.previousPath, risk.high_paths)),
    );
  return high ? "high" : "low";
}
