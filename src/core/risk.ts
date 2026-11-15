import { basename, matchesGlob } from "node:path";
import type { Config } from "./config.ts";

export type Risk = "low" | "high";

// Line counts are absent at Gate 1, where the planner only knows paths.
// "unknown" covers GitHub statuses we do not assess, such as copied or changed.
export type FileChange =
  | { status: "added" | "modified" | "deleted" | "unknown"; path: string; additions?: number; deletions?: number }
  | { status: "renamed"; path: string; previousPath: string; additions?: number; deletions?: number };

const HIGH_DIRS = new Set([".github", ".devcontainer", ".husky", ".githooks", ".claude", ".cursor", "migrations", "migrate"]);

const HIGH_FILES = new Set([
  "agents.md",
  "claude.md",
  "claude.local.md",
  ".mcp.json",
  "package.json",
  "pyproject.toml",
  "cargo.toml",
  "go.mod",
  "gemfile",
  "makefile",
  "mise.toml",
  ".mise.toml",
  "justfile",
  ".gitattributes",
  ".gitmodules",
  "codeowners",
  ".semgrepignore",
  "package-lock.json",
  "npm-shrinkwrap.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "bun.lock",
  "bun.lockb",
  "go.sum",
  "cargo.lock",
  "poetry.lock",
  "uv.lock",
  "pipfile.lock",
  "gemfile.lock",
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

// "JWTSecret" gives "JWT" and "Secret". Digits and punctuation separate words.
function words(path: string): string[] {
  return (path.match(/[A-Z]+(?![a-z])|[A-Z]?[a-z]+/g) ?? []).map((word) => word.toLowerCase());
}

function isSensitiveWord(word: string): boolean {
  return SENSITIVE_WORDS.has(word) || (word.endsWith("s") && SENSITIVE_WORDS.has(word.slice(0, -1)));
}

const ALWAYS_HIGH: ((path: string, name: string) => boolean)[] = [
  (path) => path.split("/").some((dir) => HIGH_DIRS.has(dir.toLowerCase())),
  (_, name) => HIGH_FILES.has(name.toLowerCase()),
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
  const lines = changes.reduce((sum, change) => sum + (change.additions ?? 0) + (change.deletions ?? 0), 0);
  const high =
    lines > risk.max_diff_lines ||
    changes.some(
      (change) =>
        change.status === "deleted" ||
        change.status === "unknown" ||
        // A binary file changes with no line counted.
        (change.status !== "renamed" && change.additions === 0 && change.deletions === 0) ||
        isHighPath(change.path, risk.high_paths) ||
        (change.status === "renamed" && isHighPath(change.previousPath, risk.high_paths)),
    );
  return high ? "high" : "low";
}
