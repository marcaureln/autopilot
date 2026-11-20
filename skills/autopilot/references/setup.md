# Set up autopilot

Each person runs their own GitHub App and host. Nothing is shared.

Ask the user for these values before you start. Do not guess them:

- Their GitHub login. It becomes the only owner.
- The SSH target of the host (`user@my-host`, or a `Host` alias of `~/.ssh/config`), or `local` for this machine.
- A short name for the host (`pi`). The commands use this name.
- The first repo (`example-org/app`).

The agent can run the commands that print no secret. The user runs each command marked "(user)", in their own terminal.

## 1. Prerequisites

On the user's machine (the client):

- `mise`, `curl`, `tar` for the install. `git` and `ssh`.
- `gh`, signed in as the owner (`gh auth status`).
- Claude Code (`claude`), on this machine or on any other, for `claude setup-token`.
- Only to keep the secrets in 1Password (`--backend op`): the 1Password CLI `op`, signed in to the user's account (`op whoami`). If it fails, the user runs `op signin`.
- Docker with the Compose plugin, for the agent and the checks of `autopilot init`.

On the host:

- Linux: systemd, [Docker Engine](https://docs.docker.com/engine/install/) with its [Compose plugin](https://docs.docker.com/compose/install/linux/), and for [rootless Docker](https://docs.docker.com/engine/security/rootless/) (the default) the rootless extras, `newuidmap` (package `uidmap`) and a systemd user session (package `dbus-user-session`). On Debian and Ubuntu, setup installs `mise` from its apt repository. It installs `op` only on a host that uses 1Password.
- macOS: OrbStack, Colima or Docker Desktop, running (`docker info` works), with Docker Compose (Colima: `brew install docker-compose`). With Homebrew, setup installs `mise`, and `op` only on a host that uses 1Password. The Mac must not sleep, and the user must stay logged in.
- The SSH user can run `sudo` with no password prompt (Linux). The client uses `ssh <target> <command>` with no terminal.

Setup checks these and prints an install link for each missing one. It does not install Docker.

## 2. Install the client

```sh
curl -fsSL https://marcaureln.com/autopilot/install.sh | sh
autopilot --help
autopilot alias        # optional: adds "alias ap=autopilot" to the shell rc file
```

The command goes to `~/.local/bin/autopilot`. If the install prints that `~/.local/bin` is not in `PATH`, add it. `autopilot self-update` installs the latest release later.

## 3. Run the wizard

If `autopilot --help` lists `setup`, ask the user to run `autopilot setup` in their own terminal (user). It is interactive. It uses the default host of the hosts file if there is one, and else asks for the host. It saves the host under the host part of its SSH target. If that name is not valid (for example for `user@[fe80::1]`), it stops before it changes anything: ask the user to pass `--name <name>`. It asks for the owner, the repo and the Claude token. It asks if the agents can change GitHub Actions workflows (default: yes; see step 4). It does steps 4 to 8. With `--backend op`, it keeps the secrets in 1Password. You can run it again safely, because it fixes only what is missing. Then go to step 9 and check each result there.

If `setup` is not listed, or it stops on a step, do steps 4 to 8.

### Without prompts

Put the answers in a file ([schema](../../../schema/setup.schema.json)), then run `autopilot setup --config setup.json --yes`:

```json
{
	"$schema": "https://raw.githubusercontent.com/marcaureln/autopilot/main/schema/setup.schema.json",
	"app_id": 123456,
	"host": "user@my-host",
	"allow": ["octocat/app"],
	"alias": "ap"
}
```

GitHub needs a click in the browser to create an App, so run `autopilot app create` first. For an App that you already have, set `app_key` to the path of its `.pem` file. Set `workflows` to `false` if the agents must not change GitHub Actions workflows. Give the Claude token in `CLAUDE_CODE_OAUTH_TOKEN`. The file never holds a secret value.

## 4. GitHub App

If `autopilot --help` lists `app create`, ask the user to run `autopilot app create` (user). It creates the App through GitHub's manifest flow and saves its key in `~/.config/autopilot/app-key.pem` (mode 600). `autopilot hosts add` pushes the key from there. With `--backend op`, it saves the key in 1Password. The App gets the Workflows permission, so the agents can change files in `.github/workflows/`. A person still reviews each such pull request. To create the App without this permission, add `--no-workflows`.

Otherwise, the user creates it by hand at GitHub > Settings > Developer settings > GitHub Apps > New GitHub App:

- Name: `<login>-autopilot`.
- Webhook: off (clear "Active"). autopilot polls GitHub.
- Repository permissions: Contents read and write, Issues read and write, Pull requests read and write, Commit statuses read and write, Metadata read. Add Workflows read and write to let the agents change GitHub Actions workflows.
- Where it can be installed: "Only on this account", or "Any account" to allow organizations.
- After the creation: note the App ID, then generate a private key (a `.pem` file).

### Add the Workflows permission

Without the Workflows permission, autopilot does not change files in `.github/workflows/`. `autopilot setup` does not change an existing App. When the answer to its question is yes and the App does not have the permission, it shows these steps:

1. Open the App settings (GitHub > Settings > Developer settings > GitHub Apps > the App), then "Permissions & events" (user).
2. Set "Workflows" (Repository permissions) to "Read and write", then save (user).
3. Accept the new permission on the installation page of each account where the App is installed (user). GitHub sends an email with the link.

The host sees the permission at the next job.

## 5. Host secrets

The host reads two secrets when it starts: the App key and the Claude token. By default, they are files on the host, and `autopilot hosts add` writes them in step 6. Before step 6, the user runs `claude setup-token` (user) on any machine with Claude Code. It prints a token. The user pastes it at the hidden prompt of step 6, or sets it in `CLAUDE_CODE_OAUTH_TOKEN`. Then go to step 6.

### With 1Password (`--backend op`)

The host reads its secrets from a vault named `autopilot`. The names below are fixed. The CLI reads these exact references.

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

Do not read or print any of these values. By default, `autopilot secrets set` writes repo secrets to a file on the host. With `--backend op`, it writes them to the same vault, in one item per repo.

## 6. Host

The user runs it (user), because it can ask for the Claude token at a hidden prompt:

```sh
autopilot hosts add pi user@my-host --owner <login> --app-id <id>
autopilot hosts add mac local --owner <login> --app-id <id>      # this machine
```

It writes `host.json` if the host has none, installs the latest release and starts the service. It pushes each secret that the host does not have, over SSH on stdin:

- The App key, from `--app-key <pem file>`, else from `~/.config/autopilot/app-key.pem`. It checks that the key opens the App first.
- The Claude token, from `CLAUDE_CODE_OAUTH_TOKEN`, else from a hidden prompt. If Claude Code is on the machine, it offers to run `claude setup-token`.

The files are `app-key.pem` and `claude-token` in `/etc/autopilot/secrets` (Linux: owner root, group `autopilot`, mode 640) or in `~/.autopilot/secrets` (macOS: mode 600). `--owner` and `--app-id` are needed only the first time. Run it again to repair a host. Each step checks before it acts, and it does not ask again for a secret that the host has. A re-run keeps a file that exists, so a wrong secret stays on the host. To replace one, for example a wrong Claude token, remove its file (`/etc/autopilot/secrets/claude-token` on Linux, `~/.autopilot/secrets/claude-token` on macOS), then run the same `autopilot hosts add` command again. It asks only for the missing secret, writes it and restarts the service. The host name in claim comments is the short `hostname` of the host.

With `--backend op`, a new `host.json` has `op://` references, and `hosts add` pushes the service account token instead. To change that token, remove `/etc/autopilot/op-token` (Linux) or `~/.autopilot/op-token` (macOS) on the host first. The references in `host.json` decide, so a host keeps its backend when you run `hosts add` again.

`host.json` has one owner. To add an owner, edit `owners` in `host.json` on the host (`/etc/autopilot/host.json` on Linux, `~/.autopilot/host.json` on macOS), then run `autopilot hosts add` again.

At the end, `hosts add` saves the host in `~/.config/autopilot/hosts.json`. The first host that you add becomes the default host, so the next commands act on it. Check it with `autopilot hosts`. To act on another host, pass `--host <name>`, or make it the default with `autopilot hosts default <name>`. The hosts file is `~/.config/autopilot/hosts.json`, or `$XDG_CONFIG_HOME/autopilot/hosts.json`.

How the client finds and reaches a host:

- A command takes its host from `--host`, else `AUTOPILOT_HOST`, else the default host of the hosts file. If the value is a name in the hosts file, the command uses the SSH target of that host. If not, it uses the value as an SSH target, or as `local`.
- The client gives the target to `ssh` as it is, so a `Host` alias of `~/.ssh/config` works. A name in the hosts file wins over a `Host` alias of the same name.
- The client forwards each host command over SSH, with `--host=`. Under `sudo`, the host also skips its hosts file. So a forwarded command never reads the hosts file on the host.
- A command that the user types on a host that has a hosts file acts on that file's default host. Tell the user to pass `--host local` to act on the host itself.
- An old client sends no `--host=` to a macOS host. A macOS host that has a hosts file then forwards the command again. Update the client with `autopilot self-update`.
- `autopilot host setup --host <target>` is the old name of `hosts add`. It still works, and saves the host under `--name`, else the host part of the SSH target, else the short hostname for `local`. If that name is not valid, for example for `user@[fe80::1]`, it stops before it changes anything. Pass `--name`.

## 7. Watch the repo

```sh
autopilot watch example-org/app      # one repo
autopilot watch example-org          # every repo of an account
```

If the App is not installed on that account, the command prints the install page and opens it. The user installs the App on the repo there. You can run `autopilot watch` again safely. `autopilot init` in step 8 also watches the repo.

## 8. Onboard the repo

`init` clones the repo itself, so no checkout is necessary. Its agent runs in Docker on the user's machine, so it needs the Claude token: from `CLAUDE_CODE_OAUTH_TOKEN`, else from a hidden prompt (user). With `--backend op`, it reads the `claude-token` item from step 5.

```sh
autopilot init --repo example-org/app
```

An agent writes `.devcontainer/` (only if the repo has none), the check commands and a draft `AGENTS.md`. Then `init` checks `.devcontainer/` with the guardrails, starts it (which runs the install), runs each check once, creates the five labels, and opens a pull request from the user's account, on the branch `autopilot/onboarding`. It works for any language. You can run it again safely, because it updates the same pull request. With a host (the default host, or `--host`), it also watches the repo.

Ask the user for skills and notes before you run it. `--skill <source>` (repeatable, `github.com/<owner>/<repo>[//<path>][#<ref>]` or a host path) gives the agent a skill and adds it to `skills.planner` and `skills.builder`. `--notes <file>` adds the user's own instructions to the prompt, for example "the tests need Postgres 18".

`init` keeps an existing `.devcontainer/` and does not change it, even when it is out of date (for example the file of an older autopilot stack pack). If a check fails in the pull request but passes on the user's machine, see "Debug the dev container" in SKILL.md.

A config from an older autopilot has a `stack` field. autopilot then stops each issue with an invalid config. Run `autopilot init` again to fix it.

Read the pull request with the user, then merge it. Its "Environment" section names the image, the services, the install, and why. autopilot needs `.github/autopilot.json` on the default branch. `init` sets `"merge": "auto"`, so the merge gate merges low-risk pull requests with no review. Change it to `"manual"` to review each pull request.

## 9. Check

```sh
autopilot status
```

The service is `active` (Linux) or `running` (macOS), and `watch` lists the repo. If a log line shows `the secret file ... is missing or empty`, run `autopilot hosts add` again. If a log line shows `op read ... failed`, a 1Password item or the service account is wrong. Then create a small first issue with the `autopilot` label (see SKILL.md), and follow it with `autopilot logs`.

## Use OpenCode for a role

A role can use OpenCode instead of Claude Code. OpenCode uses a provider API key. A Claude subscription does not work with OpenCode.

1. Add the key to the host. Use the name of the env var that OpenCode reads:

   ```sh
   OPENAI_API_KEY=<key> autopilot hosts add <name> <ssh-target> --api-key OPENAI_API_KEY
   ```

   The command adds `"OPENAI_API_KEY": "file:openai_api_key"` to `secrets.api_keys` in `host.json`. It writes the key to the secrets folder of the host and restarts the service. If you do not set the env var, the command asks for the key with a hidden prompt. Repeat `--api-key` for more keys.
2. In `.github/autopilot.json`, set the harness of the role:

   ```json
   "builder": { "harness": "opencode", "model": "anthropic/claude-sonnet-5-5", "effort": "high" }
   ```

The model is `<provider>/<model>`. The effort is the model variant: if the model has no variant with that name, the run fails. Only OpenCode gets the API keys. It reads the repo's `AGENTS.md`. `autopilot init` always uses Claude Code.

You trust the repo with the API key in the same way as with the Claude token. The builder runs in the repo's dev container, and the repo controls that container: its image, its install commands, and the commands that the agent runs, such as the tests. All of them can read the key. autopilot stops only a repo config file or a dev container env var from sending the key to another server. OpenCode does not read the repo's `opencode.json` or `.opencode/`. The agent starts without the `OPENCODE_*` and `XDG_*` env vars of the dev container. The OpenCode config folder in the container is a read-only folder of the host.

## Several hosts

Run step 6 for each host, with its own name. Pass `--host <name>` to act on a host that is not the default. Hosts can watch the same repos. The oldest claim comment on an issue decides which host works on it.
