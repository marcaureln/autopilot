# AGENTS.md

## Project

autopilot turns GitHub issues into pull requests with coding agents on the user's own machine. It is one Node.js process with no server, queue or database: GitHub (labels, comments, statuses, pull requests) holds all the state. The `autopilot` command is a client on the user's machine that forwards most commands over SSH to a host; the host runs the service, which runs a planner agent, a builder agent in the repo's dev container, the checks and a merge gate.

The code is TypeScript, run directly by Node (type stripping). There is no build step.

## Install

Tools are pinned in `mise.toml` (Node 26.13.1, pnpm 12.21.0).

```sh
mise install          # outside the dev container
pnpm install --frozen-lockfile
```

## Checks

```sh
pnpm types   # tsc (noEmit, strict)
pnpm lint    # oxlint
pnpm test    # node --test
pnpm check   # all three, as CI runs them
```

Run one test file with `node --test src/core/secrets.test.ts`. The tests need `git`, `sh` and `mkfifo`, but no network and no Docker. `scripts/smoke/devcontainer.ts` is a separate smoke test that needs real Docker; CI runs it on a clean host, not in `pnpm check`.

## Layout

- `src/cli.ts`: the entry point. It parses arguments with `node:util` `parseArgs` and holds the `--help` text (`USAGE`).
- `src/commands/`: one file per CLI command (`setup`, `init`, `hosts`, `secrets`, `watch`, `run`, `app`, `alias`, `client`, `host`). `fake-github.ts` is a test double.
- `src/core/`: the logic: config and host files, secrets (`secrets.ts`, `repo-secrets.ts`), the dev container validation and CLI, Docker, checks, planner, builder, onboarding, gate, claims, state, audit log, file layout (`layout.ts`).
- `src/harness/`: the coding agent harnesses (`claude.ts`, `opencode.ts`).
- `src/web/pages.ts`: pages the client serves during setup.
- `schema/`: JSON Schemas of the config files and of the agent result files.
- `scripts/`: host setup shell scripts (`setup.sh`, `setup-macos.sh`, `common.sh`) and `smoke/`.
- `docker/`: the harness images and dev container features (`claude/`, `opencode/`).
- `skills/autopilot/`: the agent skill for users (`SKILL.md`, `references/setup.md`).
- `install.sh`: the client installer. `README.md`: the user docs.

## Conventions

- ES modules. Import local files with the `.ts` extension, and types with `import type` (`verbatimModuleSyntax`).
- Only erasable TypeScript syntax (`erasableSyntaxOnly`): no enums, namespaces or parameter properties.
- `noUncheckedIndexedAccess` is on: handle `undefined` from index access.
- Tests sit next to the code as `*.test.ts`, with `node:test` and `node:assert/strict`. Table-driven cases are common.
- Dependencies are pinned to exact versions in `package.json`; keep `pnpm-lock.yaml` in sync.
- 2-space indent, double quotes, semicolons. Comments explain why, in short sentences.
- User-facing text (README, skill, `--help`, error messages) uses short, plain sentences and tells the user what to do next.
- Never put a secret value in an argument, a log, an issue or a file other than the secrets store.
- Commit messages follow Conventional Commits, for example `docs(skill): ...`.
- When a command or flag changes, update `--help` in `src/cli.ts`, the README, `skills/autopilot/` and the matching schema together.
