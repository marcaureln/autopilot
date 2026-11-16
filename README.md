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

## Quick start

Install the client (see [Install](#install)), then run one command:

```sh
autopilot setup
```

The wizard checks the tools it needs (git, ssh, mise, op, gh) and prints the install command for a missing one. Then it creates the 1Password vault `autopilot`, your GitHub App, the Claude token and a host (an SSH target, or `local` for this machine), and allows your accounts and repos on the host. At the end it can onboard a first repo and add the `ap` alias. Run it again at any time: each step checks what is in place and only does what is missing.

To run it without prompts, put the answers in a file ([schema](schema/setup.schema.json)) and pass `--yes`:

```sh
autopilot setup --config setup.json --yes
```

```json
{
	"$schema": "https://raw.githubusercontent.com/marcaureln/autopilot/main/schema/setup.schema.json",
	"app_id": 123456,
	"host": "user@my-host",
	"allow": ["octocat/app"],
	"alias": "ap"
}
```

The unattended mode cannot create the GitHub App, because GitHub needs a click in the browser. Run `autopilot app create` first, or pass the `app_id` of an App whose private key is in 1Password. Secret values are never in the file: setup reads the Claude token from 1Password, or from `CLAUDE_CODE_OAUTH_TOKEN` the first time.

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

### Onboarding

`autopilot init` onboards a repo in one pull request that you review and merge. Run it in a checkout of the repo, or pass `--repo <owner>/<repo>`. It needs `gh`, and Docker for the last two steps.

1. Detects the stack from the lockfiles (Node with npm, pnpm or yarn today) and writes `.github/autopilot.json` and `.devcontainer/` from the stack pack in `stacks/`. An existing config keeps its values.
2. Creates the five `autopilot` labels. With `AUTOPILOT_HOST` set, allows the repo on the host, which prints the App install page if the App is not installed there.
3. Runs an agent in a container (the Claude token comes from your 1Password) to correct the check commands and draft `AGENTS.md`. `--no-agent` skips it.
4. Runs the checks once on the default branch. Existing `lint` and `types` errors go to `.github/autopilot-baseline.json`, so only new errors fail.
5. Opens the pull request from your own account, with what to curate and the failing agent-readiness items.

### Secrets

A test that needs a key gets it from 1Password. Run these in a checkout of the repo, with your own 1Password sign-in:

```sh
autopilot secrets set STRIPE_KEY        # hidden prompt, or pipe the value on stdin
autopilot secrets set --from-env .env   # every key in the file
autopilot secrets list
autopilot secrets rm STRIPE_KEY
```

Each value goes to the `autopilot` vault, in one item per repo (`<owner>_<repo>`). The command adds the reference to `.github/autopilot.json`; commit it. A value is never a command argument, so it stays out of the shell history. A value must be on one line.

The host reads only the references to the repo's own item. It gives the values to the checks that run a command from `verify.commands` (such as `lint`, `types` and `test`), never to the scanners, the install step or the agent. A check that gets secrets shows only if it passed: autopilot keeps its output out of statuses, comments and the builder prompt.

The trust boundary is the same as in CI: whoever can change the code of a repo can read the secrets that the repo gets, for example from a test. Hiding the output only prevents accidents. Give a repo only test-mode or low-value keys.

## Install

The CLI on your machine is only a client. It installs for your user, without root. You need [mise](https://mise.jdx.dev/installing-mise.html), which installs the pinned Node.

```sh
curl -fsSL https://raw.githubusercontent.com/marcaureln/autopilot/main/install.sh | sh
autopilot self-update            # install the latest release, or --version vX.Y.Z
autopilot alias                  # add "alias ap=autopilot" to the rc file of your shell; --remove deletes it
```

The release goes to `~/.local/share/autopilot` and the command to `~/.local/bin/autopilot`.

## Hosts

A host runs `autopilot run` as a service and holds everything it needs: its `host.json`, the 1Password service account token, and a release from GitHub. At start, the host reads the App key and the Claude token with `op`. The client keeps no config and forwards each command to the host over SSH, like the Vault CLI with `VAULT_ADDR`. The host `local` is the machine you run the command on.

| Host | Service | Files | Logs |
| --- | --- | --- | --- |
| Linux | systemd, as the user `autopilot` with rootless Docker | `/etc/autopilot`, `/opt/autopilot` | journald |
| macOS | launchd agent of your user, with your OrbStack, Colima or Docker Desktop | `~/.autopilot` | `~/Library/Logs/autopilot` |

A macOS host runs while you are logged in, and stops while the Mac sleeps.

```sh
# Once per host: push the 1Password token, write host.json, install the latest release
autopilot host setup --host user@my-host --owner <login> --app-id <id>
autopilot host setup --host local --owner <login> --app-id <id>     # this machine

export AUTOPILOT_HOST=user@my-host
autopilot allow <owner>/<repo>   # opens the App install page if the App is not installed there
autopilot status
autopilot logs
autopilot audit --since 1d       # JSON audit events
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
