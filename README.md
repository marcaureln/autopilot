<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/autopilot-wordmark-white.svg">
    <img alt="autopilot" src="assets/autopilot-wordmark-black.svg" width="320">
  </picture>
</p>

<p align="center">Turns issues into features, with coding agents on your own machine.</p>

autopilot aims to stay small: one process, no server, no queue, no database. GitHub is the only interface and the only state. It is also agnostic: the agent harness, the models, the verification mode and the host are each one config field.

> [!WARNING]
> autopilot is in early development. Try it on a test repo first.

## Set up

### What you need

- **On your machine:** git, ssh, [mise](https://mise.jdx.dev/installing-mise.html), [gh](https://cli.github.com/) signed in to GitHub, and the [1Password CLI](https://developer.1password.com/docs/cli/get-started/) (`op`) signed in to your account. Setup prints the install command for a missing tool.
- **A Claude account** that can run `claude setup-token`. The agents use this token.
- **A host** that runs the jobs: a Linux machine that you can reach with SSH and sudo, with [Docker Engine](https://docs.docker.com/engine/install/) and its [rootless extras](https://docs.docker.com/engine/security/rootless/), and the [Compose plugin](https://docs.docker.com/compose/install/linux/), or a Mac with OrbStack, Colima or Docker Desktop. The host can also be the machine you work on.

### Steps

1. Install the client. It installs for your user, without root, in `~/.local/share/autopilot` and `~/.local/bin/autopilot`. Update it later with `autopilot self-update`.

   ```sh
   curl -fsSL https://raw.githubusercontent.com/marcaureln/autopilot/main/install.sh | sh
   ```

2. Run the setup wizard:

   ```sh
   autopilot setup
   ```

   The wizard does these steps in this order. Each step checks what is in place and only does what is missing, so you can run it again at any time.
   1. **Tools.** It checks git, ssh, mise, op and gh.
   2. **1Password.** It creates the vault `autopilot` and a service account that can only read that vault. The host uses this account to read its secrets.
   3. **GitHub App.** Select "Create a new App". Your browser opens a GitHub page: click **Create GitHub App**. The private key goes to the vault. To use an App that you already have, give its App ID and the path of its `.pem` file.
   4. **Claude token.** The wizard runs `claude setup-token`, which signs you in to Claude in the browser and prints a token. Paste the token at the hidden prompt. It goes to the vault.
   5. **Host.** Give an SSH target such as `user@my-host`, or `local` for this machine. The wizard installs the latest release on the host and starts the service.
   6. **Owner and allowlist.** Your GitHub login is the owner: only owners can start a job. Then give the accounts, orgs or `owner/repo` entries that autopilot may work on. If the App is not installed there, the wizard opens the install page: select the repos, then click **Install**.
   7. **First repo.** The wizard runs `autopilot init` on a repo that you select. It opens an onboarding pull request (see [Onboarding](#onboarding)).
   8. **Alias.** It adds `ap` as a short name for `autopilot` to your shell.

3. Review and merge the onboarding pull request. Make sure that the check commands in `.github/autopilot.json` are correct. Until this pull request is merged, autopilot stops each issue in the repo.

4. Write your first issue. Ask for one small change, name the files, and give acceptance criteria. Then add the `autopilot` label:

   ```sh
   gh issue create --repo <owner>/<repo> --title "Add docs/labels.md" --body "Add docs/labels.md that lists the autopilot labels." --label autopilot
   ```

5. Follow the issue on GitHub. Within one minute, the host posts a claim comment, then a spec. Then it builds the change, runs the checks and opens a pull request. The labels tell you when you must act:

   | Label                         | What to do                                                                |
   | ----------------------------- | ------------------------------------------------------------------------- |
   | `autopilot:working`           | Nothing. Wait.                                                            |
   | `autopilot:needs-info`        | Answer the questions of the spec in one comment.                          |
   | `autopilot:awaiting-approval` | Read the spec, then tick **Approve and build**.                           |
   | `autopilot:blocked`           | Read the last comment, fix the cause, then remove the label to try again. |

   With `"merge": "manual"` (the default from `init`), you review and merge each pull request. To see what the host does, run `autopilot logs` with `AUTOPILOT_HOST` set to your host.

### Set up without prompts

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

GitHub needs a click in the browser to create an App, so run `autopilot app create` first, or pass the `app_id` of an App whose key is in 1Password. Secret values are never in the file: setup reads the Claude token from 1Password, or from `CLAUDE_CODE_OAUTH_TOKEN` the first time.

### Set up with a coding agent

Paste this prompt into Claude Code, Codex or another coding agent:

```text
Set up autopilot for me (https://github.com/marcaureln/autopilot).
Install its agent skill with `npx skills add marcaureln/autopilot`, then follow the "Set up" section of the skill.
Ask me before each step that needs my browser, my 1Password sign-in or a secret value.
Never read, print or write a secret value yourself.
```

The [skill](skills/autopilot/SKILL.md) also teaches the agent to use autopilot day to day: write issues that autopilot can build, answer its questions, approve a spec, review its pull requests and debug a blocked issue.

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

autopilot is a small, agnostic software factory: a minimal core, with each block behind a config field or a small interface. Only the "Today" column is built.

| Block         | Today                                                                                  | Possible later       |
| ------------- | -------------------------------------------------------------------------------------- | -------------------- |
| Forge         | [GitHub](src/core/github.ts)                                                           | GitLab               |
| Agent harness | [Claude Code](src/harness/claude.ts) ([image](docker/claude))                          | OpenCode, Codex, pi  |
| Environment   | The repo's dev container ([environment](src/core/environment.ts), [guardrails](src/core/devcontainer.ts)) | -                    |
| Checks        | [Commands and scanners](src/core/checks.ts), on the host or in the repo's own CI       | -                    |
| Risk          | [Rules](src/core/risk.ts) and [gates](src/core/gate.ts)                                | -                    |
| Secrets       | [1Password CLI](src/core/secrets.ts)                                                   | Env files on the host |

## Out of scope

autopilot does one job: it turns issues into features. Everything else stays outside, on purpose:

- **Network control.** autopilot does not filter what the agents reach on the internet. If you need that, set it up on the host.
- **Learning by itself.** The factory does not change its own prompts. It gets better when you improve your skills and your `AGENTS.md`.
- **A database.** GitHub holds the state. A host keeps only its config and its secrets, and your machine only a list of hosts.
- **A UI.** You work in GitHub: issues, labels, comments and pull requests.
- **Project templates.** Each repo brings its own dev container, so autopilot works with any language or engine.
- **A hosted service.** It runs on your machines, with your accounts.

## Configuration

Each repo has a `.github/autopilot.json`, which `init` writes. The [schema](schema/autopilot.schema.json) describes each field and its default, and the `$schema` field gives autocomplete and validation in VS Code.

```json
{
	"$schema": "https://raw.githubusercontent.com/marcaureln/autopilot/main/schema/autopilot.schema.json",
	"version": 1,
	"merge": "auto"
}
```

### Checks in your own CI

The checks belong to the repo: its own commands and the scanners. `verify.mode` says where they run. By default (`host`), the autopilot host runs them. With `"verify": { "mode": "ci", "required": ["sast", "deps-scan", "secrets-scan", "test"] }`, the host runs nothing: it waits for the repo's own CI on the pull request's head. Each name in `required` is the name of a GitHub Actions job. Only a success passes: a skipped job blocks the merge. Results from other Apps or from commit statuses do not count, because anyone with write access can post them. A failed check gives its output and annotations to the builder for a fix round. [marcaureln/actions](https://github.com/marcaureln/actions) has the `sast`, `deps-scan` and `secrets-scan` scanners as composite actions.

### Onboarding

`autopilot init` onboards a repo in one pull request that you review and merge. Run it in a checkout of the repo, or pass `--repo <owner>/<repo>`. It needs `gh` and Docker with the Compose plugin.

The repo's own `.devcontainer/` is the environment of every job: the install, the checks and the builder run in it, with its compose services, so any language works. `init`:

1. Runs an agent that writes `.devcontainer/` if the repo has none (from [Anthropic's dev container](https://github.com/anthropics/claude-code/tree/main/.devcontainer), without its firewall), sets the check commands and drafts `AGENTS.md`. An existing `.devcontainer/` or config keeps its values.
2. Starts the dev container, cuts its network and runs each check once. Existing `lint` and `types` errors go to `.github/autopilot-baseline.json`, so only new errors fail.
3. Creates the `autopilot` labels and opens the pull request from your account.

`--skill <source>` (repeatable) gives the agents a skill. `--notes <file>` adds your own instructions to the onboarding agent.

The host refuses a `.devcontainer/` that reaches outside its container: host commands, `runArgs`, privileges, host mounts and namespaces, published ports, `${localEnv:...}`, and images without an exact version tag. It adds its own memory, CPU and process caps, and it cuts the outside network during the checks.

### Secrets

A test that needs a key gets it from 1Password. Run these in a checkout of the repo, with your own 1Password sign-in:

```sh
autopilot secrets set STRIPE_KEY        # hidden prompt, or pipe the value on stdin
autopilot secrets set --from-env .env   # every key in the file
autopilot secrets list
autopilot secrets rm STRIPE_KEY
```

Each value goes to the `autopilot` vault, in one item per repo (`<owner>_<repo>`). The command adds the reference to `.github/autopilot.json`; commit it. A value is never a command argument, so it stays out of the shell history. A value must be on one line.

The host gives the values only to the checks that run a command from `verify.commands`, never to the scanners, the install step or the agent, and it shows only whether such a check passed. As in CI, whoever can change the code of a repo can read its secrets, for example from a test: give a repo only test-mode or low-value keys.

## Hosts

A host runs `autopilot run` as a service. It holds its `host.json`, the 1Password service account token and a release, and it reads the App key and the Claude token with `op` at start. The client keeps no config: it forwards each command to the host over SSH. The host `local` is the machine you run the command on.

| Host  | Service                                                                  | Files                              | Logs                       |
| ----- | ------------------------------------------------------------------------ | ---------------------------------- | -------------------------- |
| Linux | systemd, as the user `autopilot` with rootless Docker                    | `/etc/autopilot`, `/opt/autopilot` | journald                   |
| macOS | launchd agent of your user, with your OrbStack, Colima or Docker Desktop | `~/.autopilot`                     | `~/Library/Logs/autopilot` |

A macOS host runs while you are logged in, and stops while the Mac sleeps.

```sh
# Once per host: push the 1Password token, write host.json, install the latest release.
# Run it again to repair or upgrade: it keeps the token the host has.
autopilot host setup --host user@my-host --owner <login> --app-id <id>
autopilot host setup --host local --owner <login> --app-id <id>     # this machine

export AUTOPILOT_HOST=user@my-host
autopilot allow <owner>/<repo>   # opens the App install page if the App is not installed there
autopilot status
autopilot logs
autopilot audit --since 1d       # JSON audit events
autopilot update                 # install the latest release, or --version vX.Y.Z
```

A host works on one issue at a time by default. To run more at once, set `concurrency` in its `host.json`. Each issue gets its own containers and `limits`, so size it to the host's memory and to the rate limits of your Claude plan.

Several hosts can share an allowlist: the oldest claim comment on an issue wins. To move an issue to another host, delete its claim comment.

## Development

```sh
mise install && pnpm install
pnpm check               # types + lint + tests
node src/cli.ts run --once --config host.json   # a dev host; op reads secrets with your sign-in
```

Node runs the TypeScript files directly. There is no build step.

## References

autopilot builds on these projects and ideas:

- [Claude Code devcontainer](https://github.com/anthropics/claude-code/tree/main/.devcontainer): Anthropic's reference devcontainer for Claude Code.
- [Dev Container CLI](https://github.com/devcontainers/cli) and the [Dev Container specification](https://containers.dev/).
- [pstack](https://github.com/michael-denyer/pstack-claude): poteto's agent workflows, used as skills for the planner and the builder.
- [superpowers](https://github.com/obra/superpowers): obra's skills for test-driven development and systematic debugging.
