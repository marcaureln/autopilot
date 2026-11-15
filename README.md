<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/autopilot-wordmark-white.svg">
    <img alt="autopilot" src="assets/autopilot-wordmark-black.svg" width="320">
  </picture>
</p>

<p align="center"><b>A simple, self-hosted software factory.</b><br>Label a GitHub issue. Get a merged pull request.</p>

autopilot aims to stay small: one process, no server, no queue, no database. GitHub is the only interface and the only state. It is also agnostic: the agent harness, the models, the verification mode and the host are each one config field.

> [!WARNING]
> autopilot is in early development and does not work end to end yet. Do not use it on a repo you care about.

## How it works

```mermaid
flowchart TB
    A([autopilot label]) --> S[Planner writes a spec]
    S --> G1{Gate 1}
    G1 -- unclear --> Q[Asks questions] --> S
    G1 -- risky --> P[Waits for your approval] --> B
    G1 -- ok --> B[Builder implements in a devcontainer]
    B --> C[Checks: lint, types, tests, scans]
    C -- fail, max 3 rounds --> B
    C -- pass --> G2{Gate 2}
    G2 -- low risk --> M([Auto-merge])
    G2 -- high risk --> R([Waits for your review])
```

Models propose and rules decide. The risk rules are deterministic, and a model can raise the risk but never lower it.

## Building blocks

Each block sits behind a config field or a small interface. Only the "Today" column is built.

| Block         | Today                          | Possible later              |
| ------------- | ------------------------------ | --------------------------- |
| Forge         | GitHub (App, labels, statuses) | GitLab, Forgejo             |
| Agent harness | Claude Code                    | OpenCode, Codex, pi         |
| Secrets       | 1Password CLI                  | OpenBao, age-encrypted file |

## Configuration

Each repo has a `.github/autopilot.json` ([full example](examples/autopilot.json)). The `$schema` field gives autocomplete and validation in VS Code.

```json
{
	"$schema": "https://raw.githubusercontent.com/marcaureln/autopilot/main/schema/autopilot.schema.json",
	"version": 1,
	"stack": ["node"],
	"merge": "auto"
}
```

## Hosts

A host runs `autopilot run` as a systemd service and holds everything it needs: its `/etc/autopilot/host.json`, the 1Password service account token, and a release from GitHub. At start, the host reads the App key and the Claude token with `op`. The CLI on your machine is only a client. It keeps no config and forwards each command to the host over SSH, like the Vault CLI with `VAULT_ADDR`.

```sh
# Once per host: push the 1Password token, write host.json, install the latest release
autopilot host setup --host user@my-host --owner <login> --app-id <id>

export AUTOPILOT_HOST=user@my-host
autopilot allow <owner>/<repo>   # opens the App install page if the App is not installed there
autopilot status
autopilot logs
autopilot audit --since 1d       # JSON audit events from journald
autopilot update                 # install the latest release, or --version vX.Y.Z
```

Several hosts can share an allowlist. Before a host acts on an issue, it posts a claim comment. The oldest claim wins, and the other hosts skip the issue. To move an issue to another host, delete its claim comment.

## Development

```sh
mise install && pnpm install
pnpm check               # types + lint + tests
node src/cli.ts run --once --config host.json   # a dev host; op reads secrets with your sign-in
```

Node runs the TypeScript files directly. There is no build step.
