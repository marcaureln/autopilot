import { test } from "node:test";
import assert from "node:assert/strict";
import { assessRisk, type FileChange, type Risk } from "./risk.ts";

const defaults = { high_paths: [], max_diff_lines: 500 };

function modified(path: string, lines = 10): FileChange {
  return { status: "modified", path, additions: lines, deletions: 0 };
}

const cases: { name: string; changes: FileChange[]; risk?: { high_paths: string[]; max_diff_lines: number }; expected: Risk }[] = [
  { name: "no changes", changes: [], expected: "low" },
  { name: "plain source file", changes: [modified("src/index.ts")], expected: "low" },
  { name: "added readme", changes: [{ status: "added", path: "README.md", additions: 20, deletions: 0 }], expected: "low" },
  { name: "word that only starts like a sensitive word", changes: [modified("src/author.ts")], expected: "low" },
  { name: "word that only contains a sensitive word", changes: [modified("src/tokenizer.ts")], expected: "low" },
  { name: "exactly max_diff_lines", changes: [{ status: "modified", path: "src/a.ts", additions: 250, deletions: 250 }], expected: "low" },
  { name: "plain rename", changes: [{ status: "renamed", path: "src/b.ts", previousPath: "src/a.ts", additions: 0, deletions: 0 }], expected: "low" },

  ...[".github/workflows/ci.yml", ".github/autopilot.json", ".devcontainer/devcontainer.json"].map((path) => ({
    name: `github or devcontainer: ${path}`,
    changes: [modified(path)],
    expected: "high" as const,
  })),
  ...["AGENTS.md", "packages/x/AGENTS.md"].map((path) => ({ name: `agents file: ${path}`, changes: [modified(path)], expected: "high" as const })),
  ...[
    "package-lock.json",
    "pnpm-lock.yaml",
    "yarn.lock",
    "bun.lock",
    "go.sum",
    "Cargo.lock",
    "poetry.lock",
    "uv.lock",
    "Gemfile.lock",
    "composer.lock",
    "apps/web/pnpm-lock.yaml",
  ].map((path) => ({ name: `lockfile: ${path}`, changes: [modified(path)], expected: "high" as const })),
  ...["db/migrations/001.sql", "prisma/migrations/x/migration.sql", "db/migrate/20261115_add_users.rb"].map((path) => ({
    name: `migration: ${path}`,
    changes: [modified(path)],
    expected: "high" as const,
  })),
  ...[
    "src/auth/login.ts",
    "src/Auth/index.ts",
    "src/authService.ts",
    "src/OAuth.ts",
    "lib/security.ts",
    "src/payment-service.ts",
    "billing/invoice.ts",
    "src/user_sessions.ts",
    "src/tokens.ts",
    "src/stripe/webhook.ts",
    "src/rbac.ts",
    "src/checkout/page.tsx",
  ].map((path) => ({ name: `sensitive word: ${path}`, changes: [modified(path)], expected: "high" as const })),
  ...["infra/main.tf", "prod.tfvars", "Dockerfile", "docker/Dockerfile.dev", "api.Dockerfile", "compose.yaml", "docker-compose.prod.yml"].map(
    (path) => ({ name: `infrastructure: ${path}`, changes: [modified(path)], expected: "high" as const }),
  ),
  ...[".env", ".env.local", ".env.example", "apps/web/.env.production"].map((path) => ({
    name: `env file: ${path}`,
    changes: [modified(path)],
    expected: "high" as const,
  })),
  ...["vite.config.ts", "next.config.mjs", "tsconfig.json", "tsconfig.build.json", ".npmrc", ".eslintrc.json"].map((path) => ({
    name: `config file: ${path}`,
    changes: [modified(path)],
    expected: "high" as const,
  })),

  { name: "deleted file", changes: [{ status: "deleted", path: "src/old.ts", additions: 0, deletions: 3 }], expected: "high" },
  {
    name: "rename into a sensitive path",
    changes: [{ status: "renamed", path: "src/auth/x.ts", previousPath: "src/x.ts", additions: 0, deletions: 0 }],
    expected: "high",
  },
  {
    name: "rename out of a sensitive path",
    changes: [{ status: "renamed", path: "src/x.ts", previousPath: "src/auth/x.ts", additions: 0, deletions: 0 }],
    expected: "high",
  },
  { name: "over max_diff_lines across files", changes: [modified("src/a.ts", 300), modified("src/b.ts", 201)], expected: "high" },
  { name: "custom max_diff_lines", changes: [modified("src/a.ts", 101)], risk: { high_paths: [], max_diff_lines: 100 }, expected: "high" },
  { name: "repo high_paths match", changes: [modified("src/core/a.ts")], risk: { high_paths: ["src/core/**"], max_diff_lines: 500 }, expected: "high" },
  { name: "repo high_paths no match", changes: [modified("src/other.ts")], risk: { high_paths: ["src/core/**"], max_diff_lines: 500 }, expected: "low" },
  { name: "one high file among low files", changes: [modified("src/a.ts"), modified("yarn.lock"), modified("src/b.ts")], expected: "high" },
];

for (const { name, changes, risk = defaults, expected } of cases) {
  test(name, () => {
    assert.equal(assessRisk(changes, risk), expected);
  });
}
