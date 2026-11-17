# Set up autopilot

Each person runs their own GitHub App, host and 1Password vault. Nothing is shared.

Ask the user for these values before you start. Do not guess them:

- Their GitHub login. It becomes the only owner.
- The SSH target of the host (`user@my-host`), or `local` for this machine.
- The first repo (`example-org/app`).

The agent can run the commands that print no secret. The user runs each command marked "(user)", in their own terminal.

## 1. Prerequisites

On the user's machine (the client):

- `mise`, `curl`, `tar` for the install. `git` and `ssh`.
- `gh`, signed in as the owner (`gh auth status`).
- The 1Password CLI `op`, signed in to the user's account (`op whoami`). If it fails, the user runs `op signin`.
- Claude Code (`claude`), for `claude setup-token`.
- Docker with the Compose plugin, for the agent and the checks of `autopilot init`.

On the host:

- Linux: systemd, [Docker Engine](https://docs.docker.com/engine/install/) with its [Compose plugin](https://docs.docker.com/compose/install/linux/), and for [rootless Docker](https://docs.docker.com/engine/security/rootless/) (the default) the rootless extras, `newuidmap` (package `uidmap`) and a systemd user session (package `dbus-user-session`). On Debian and Ubuntu, setup installs `mise` and `op` from their apt repositories.
- macOS: OrbStack, Colima or Docker Desktop, running (`docker info` works), with Docker Compose (Colima: `brew install docker-compose`). With Homebrew, setup installs `mise` and `op`. The Mac must not sleep, and the user must stay logged in.
- The SSH user can run `sudo` with no password prompt (Linux). The client uses `ssh <target> <command>` with no terminal.

Setup checks these and prints an install link for each missing one. It does not install Docker.

## 2. Install the client

```sh
curl -fsSL https://raw.githubusercontent.com/marcaureln/autopilot/main/install.sh | sh
autopilot --help
autopilot alias        # optional: adds "alias ap=autopilot" to the shell rc file
```

The command goes to `~/.local/bin/autopilot`. If the install prints that `~/.local/bin` is not in `PATH`, add it. `autopilot self-update` installs the latest release later.

## 3. Run the wizard

If `autopilot --help` lists `setup`, ask the user to run `autopilot setup` in their own terminal (user). It is interactive: it asks for the host, the owner and the repo. It does steps 4 to 8, and it is safe to run again: it fixes what is missing. Then go to step 9 and check each result there.

If `setup` is not listed, or it stops on a step, do steps 4 to 8.

## 4. GitHub App

If `autopilot --help` lists `app create`, ask the user to run `autopilot app create` (user). It creates the App through GitHub's manifest flow and stores its key.

Otherwise, the user creates it by hand at GitHub > Settings > Developer settings > GitHub Apps > New GitHub App:

- Name: `<login>-autopilot`.
- Webhook: off (clear "Active"). autopilot polls GitHub.
- Repository permissions: Contents read and write, Issues read and write, Pull requests read and write, Commit statuses read and write, Metadata read.
- Where it can be installed: "Only on this account", or "Any account" to allow organizations.
- After the creation: note the App ID, then generate a private key (a `.pem` file).

## 5. 1Password

The host reads its secrets from a vault named `autopilot`. The names below are fixed: the CLI reads these exact references.

| Item title | Type | Field | Value |
| --- | --- | --- | --- |
| `github-app-private-key` | Document | file `app.pem` | The App private key |
| `claude-token` | API Credential | `credential` | The output of `claude setup-token` |
| `op-service-account-token` | Password | `password` | The token of the service account below |

1. If `op vault get autopilot` fails, create the vault: `op vault create autopilot`.
2. Store the App key (user): `op document create <path-to-key>.pem --vault autopilot --title github-app-private-key --file-name app.pem`. When `op item get github-app-private-key --vault autopilot` finds it, the user removes the downloaded file.
3. The user runs `claude setup-token` (user) and saves the token in a new `claude-token` item, in the 1Password app.
4. The user creates a service account with read access to the vault (user): `op service-account create autopilot-host --vault autopilot:read_items`. 1Password shows the token once. The user saves it in a new `op-service-account-token` item.
5. Check the three items, with no values: `op item list --vault autopilot`.

Do not read or print any of these values. `autopilot secrets set` later writes repo secrets to the same vault, in one item per repo.

## 6. Host

```sh
autopilot host setup --host user@my-host --owner <login> --app-id <id>
autopilot host setup --host local --owner <login> --app-id <id>      # this machine
```

It pushes the service account token if the host has none, writes `host.json` if the host has none, installs the latest release and starts the service. `--owner` and `--app-id` are needed only the first time. Run it again to repair a host: each step checks before it acts. To change the token, remove `/etc/autopilot/op-token` on the host first. The host name in claim comments is the short `hostname` of the host.

`host.json` has one owner. To add an owner, edit `owners` in `host.json` on the host (`/etc/autopilot/host.json` on Linux, `~/.autopilot/host.json` on macOS), then run `autopilot host setup` again.

Then set the host for the next commands:

```sh
export AUTOPILOT_HOST=user@my-host
```

## 7. Allow the repo

```sh
autopilot watch example-org/app      # one repo
autopilot watch example-org          # every repo of an account
```

If the App is not installed on that account, the command prints the install page and opens it. The user installs the App on the repo there. To watch again is harmless: `autopilot init` in step 8 also watches the repo.

## 8. Onboard the repo

`init` clones the repo itself, so no checkout is necessary. It needs the `claude-token` item from step 5: its agent runs in Docker on the user's machine.

```sh
autopilot init --repo example-org/app
```

An agent writes `.devcontainer/` (only if the repo has none), the check commands and a draft `AGENTS.md`. Then `init` checks `.devcontainer/` with the guardrails, starts it (which runs the install), runs each check once, creates the five labels, and opens a pull request from the user's account, on the branch `autopilot/onboarding`. It works for any language. It is safe to run again: it updates the same pull request. With `AUTOPILOT_HOST` set, it also allows the repo.

Ask the user for skills and notes before you run it. `--skill <source>` (repeatable, `github.com/<owner>/<repo>[//<path>][#<ref>]` or a host path) gives the agent a skill and adds it to `skills.planner` and `skills.builder`. `--notes <file>` adds the user's own instructions to the prompt, for example "the tests need Postgres 18".

`init` keeps an existing `.devcontainer/` and does not change it, even when it is out of date (for example the file of an older autopilot stack pack). If a check fails in the pull request but passes on the user's machine, see "Debug the dev container" in SKILL.md.

A config from an older autopilot has a `stack` field. autopilot then stops each issue with an invalid config: run `autopilot init` again.

Read the pull request with the user, then merge it. Its "Environment" section names the image, the services, the install, and why. autopilot needs `.github/autopilot.json` on the default branch. `init` sets `"merge": "manual"`, so every pull request of autopilot waits for a review. Change it to `"auto"` to let Gate 2 merge low-risk pull requests.

## 9. Check

```sh
autopilot status
```

The service is `active` (Linux) or `running` (macOS), and `watch` lists the repo. The log lines must show no `op read ... failed`: that means a 1Password item or the service account is wrong. Then create a small first issue with the `autopilot` label (see SKILL.md), and follow it with `autopilot logs`.

## Several hosts

Run step 6 for each host. Hosts can watch the same repos: the oldest claim comment on an issue decides which host works on it.
