---
name: autopilot
description: This skill should be used to set up and use autopilot, a tool that turns issues into features, with coding agents on the user's own machine. Use it when the user asks to "set up autopilot", "install autopilot", "add a host", "onboard this repo to autopilot", "have autopilot build this", "write an issue for autopilot", "approve the autopilot spec", "answer autopilot's questions", "review the autopilot PR", "why is my autopilot issue blocked", "retry the autopilot issue", "stop autopilot on this issue", "move the issue to another host", "add a secret for autopilot", "watch a repo", "read the autopilot logs", "a check fails only in autopilot", or "debug the dev container".
---

# autopilot

autopilot runs on a host as a service. Each minute, it reads the GitHub issues that have the `autopilot` label in the watched repos. For each issue, a planner agent writes a spec, a builder agent writes the code in a container, checks run, and a gate merges the pull request or asks for a review. GitHub holds all the state: labels, comments, commit statuses and pull requests.

The `autopilot` command on the user's machine is only a client. It keeps one file, `~/.config/autopilot/hosts.json`, with a name and an SSH target for each host. That file holds no secret. A command acts on the host of `--host <name | ssh-target>`, else of `AUTOPILOT_HOST`, else on the default host of the file. A name in the file wins over a `Host` alias of the same name in `~/.ssh/config`. The target `local` is the machine that runs the command. `autopilot hosts` shows the hosts and the default.

Before any command, run `autopilot --help` and use only the commands that it lists. The CLI is the reference. When this skill and `--help` do not agree, `--help` is correct.

## Rules for the agent

- Never read, print, or put a secret value in a command argument, an issue, a comment, or a file. Let the user type secret values at a hidden prompt.
- Interactive commands (`autopilot setup`, `autopilot hosts add` and `autopilot init` when they ask for the Claude token, `autopilot secrets set <NAME>` with a hidden prompt, `op signin`) need a terminal. Ask the user to run them in their own terminal, then continue.
- Approve a spec or merge a pull request only when the user asked for it, or after you show the user the spec or the diff and they agree.
- The user's `gh` account must be an owner on the host (`owners` in `host.json`). autopilot ignores labels, replies and ticks from other accounts.

## Set up

To set up from nothing, read `references/setup.md` and follow it. In short:

1. Install the client: `curl -fsSL https://marcaureln.com/autopilot/install.sh | sh`. It needs `mise`, `curl` and `tar`.
2. If `autopilot --help` lists `setup`, ask the user to run `autopilot setup` in their terminal. The wizard creates the GitHub App, the host with its secrets, the watched entries and the first onboarding PR. By default, the host keeps its secrets in files. With `--backend op`, they go to 1Password.
3. If `setup` is not available, or it stops, do the steps one by one: `autopilot app create`, `autopilot hosts add`, `autopilot watch`, `autopilot init`. `references/setup.md` gives each step.
4. Check the host with `autopilot status`. The service must be `active` (Linux) or `running` (macOS), and the watched entries must show the repo.
5. Merge the onboarding pull request. Before the merge, each issue in the repo waits.

## Onboard a repo with an issue

You can onboard a repo without `autopilot init`. Open an issue in a watched repo that has no `.github/autopilot.json`, and add the `autopilot` label from an owner's account. The host then runs the onboarding agent, opens the pull request "Set up autopilot", and comments on the issue with its link. The issue body tells the onboarding agent what the project is. For an empty repo, write what to build and with which tools, for example "A 2D platformer in Godot 4".

```sh
gh issue create --repo example-org/game --title "A 2D platformer in Godot 4" --body-file issue.md --label autopilot
```

Then tell the user to review and merge the pull request. The host never merges it. After the merge, the host writes the spec of the same issue. Each other labeled issue in the repo waits for the merge.

## Write an issue that autopilot can build

The planner reads the issue title, the body, and the comments of owners. It asks questions (`autopilot:needs-info`) when it must guess. It asks for approval (`autopilot:awaiting-approval`) when the scope is too broad or the risk is high. To go directly to the build, follow these rules:

- Ask for one small change. One focused pull request, below `risk.max_diff_lines` changed lines (default 500). Do not mix unrelated changes.
- Say the goal in one or two sentences.
- Name the files to add or change, when you know them. Give exact paths.
- Give the exact content or behavior when it matters: a heading, a sentence, a function name, a command output.
- Write acceptance criteria that a check or a reader can verify.
- Say what is out of scope ("Change no other file").
- Do not ask for a change in a high-risk path unless it is necessary (see "Risk rules"). Such a change always waits for approval at the plan gate and for a review at the merge gate.
- Do not ask the planner what it can find in the code. Do not write instructions for the agents about how they work. The planner ignores them.
- Never put a secret, a token, a password or a private URL in an issue or a comment. Issues can be public, and the text goes to the agents.

Template:

```markdown
## Goal
Add `docs/limits.md` that lists the default limits of autopilot for this repo.

## Files
- `docs/limits.md` (new)

## Acceptance criteria
- The file has a `# Limits` heading and one bullet per limit, with its value.
- No other file changes.
```

A vague issue such as "Make it better" always gets `autopilot:needs-info`.

## Start a job

Create the issue with the label, from the user's own `gh` account:

```sh
gh issue create --repo example-org/app --title "Add docs/limits.md" --body-file issue.md --label autopilot
```

To start on an existing issue: `gh issue edit <n> --repo example-org/app --add-label autopilot`.

The host acts within one poll interval (`poll_interval_seconds` in its `host.json`, 60 s by default). Each poll makes two GitHub searches for each App installation, and more requests only for the repos that have an open `autopilot` issue. The number of watched repos does not change the cost. GitHub allows 30 searches per minute. It works on `concurrency` issues at a time (1 by default, in its `host.json`). The planner takes a few minutes. The build and the checks can take up to `limits.run_timeout_minutes` (default 45). Check the issue every few minutes:

```sh
gh issue view <n> --repo example-org/app --json labels,state --jq '{state, labels: [.labels[].name]}'
gh issue view <n> --repo example-org/app --comments
```

## Labels

autopilot uses five labels. An issue has `autopilot` and at most one `autopilot:*` label.

| Label | Who acts | Meaning and action |
| --- | --- | --- |
| `autopilot` | The user | Starts the job. It stays on the issue for the whole job. Remove it to stop the job. |
| `autopilot:working` | The host | The host writes the spec, builds, runs the checks or runs a fix round. Wait. |
| `autopilot:needs-info` | The user | The planner asks questions. Answer them in one comment. |
| `autopilot:awaiting-approval` | The user | The plan gate found high risk or a broad scope. Read the spec, then tick `- [ ] Approve and build`. |
| `autopilot:blocked` | The user | autopilot stopped. Read the last comment, fix the cause, then remove the label to retry. |

A pull request that waits for a review has no label. The issue keeps `autopilot:working`, the host comments "Pull request #N passed every check and waits for a review: <reasons>", and requests a review from the owners on the pull request.

## Follow the issue

### The issue has `autopilot:needs-info`

1. Read the spec comment. Its `## Questions` section lists the questions.
2. Answer each question in one new comment, from an owner account: `gh issue comment <n> --repo example-org/app --body-file answers.md`.
3. The host hides the old spec as Outdated and writes a new spec. Do not edit the issue body to answer. Only a new owner comment starts a new spec.

When the builder needs a secret that the checks do not get, the host also uses `autopilot:needs-info`. Its comment names the secrets. Add each one with `autopilot secrets set <NAME>` (see "Secrets"), then reply in a comment. With `--backend op`, also merge the change to `.github/autopilot.json` before you reply.

### The issue has `autopilot:awaiting-approval`

1. Read the spec comment: goal, plan, files, and the `## Assessment` section (scope, risk, planned files).
2. If the plan is wrong, do not tick. Write a comment with the correction, then remove the `autopilot:awaiting-approval` label. The planner writes a new spec that uses the comment.
3. If the plan is correct and the user agrees, tick the box from an owner account. The box must stay the last line of the comment:

```sh
repo=example-org/app; n=12
id=$(gh api "repos/$repo/issues/$n/comments" --paginate --jq '.[] | select(.body | startswith("<!-- autopilot:spec")) | .id' | tail -1)
gh api "repos/$repo/issues/comments/$id" --jq .body | sed 's/^- \[ \] Approve and build$/- [x] Approve and build/' > spec.md
gh api -X PATCH "repos/$repo/issues/comments/$id" -F body=@spec.md
```

The host accepts the tick only when every edit of the spec comment is by an owner. If someone else edited it, remove `autopilot:awaiting-approval` to get a new spec.

### A pull request waits for a review

The merge gate asks for a review when one of these is true: `merge` is `manual` in `.github/autopilot.json`, the risk rules rate the diff high, the planner rated the risk high, the spec records no planner risk, someone other than autopilot pushed the head commit, or the pull request does not target the default branch.

1. Find the pull request. The comment names it. Its branch is `autopilot/<n>-<title>`.
2. Check the statuses: `gh pr checks <pr> --repo example-org/app`. Each check is a commit status named `autopilot/<check>`.
3. Read the diff: `gh pr diff <pr> --repo example-org/app`. Compare it with the spec and the acceptance criteria.
4. If it is correct and the user agrees, approve and merge it. autopilot itself merges with squash, so do the same:

```sh
gh pr review <pr> --repo example-org/app --approve
gh pr merge <pr> --repo example-org/app --squash --delete-branch
```

The pull request body has `Fixes #<n>`, so the merge closes the issue. At its next loop, the host removes the autopilot labels from a closed issue.

To ask for changes, do not comment on the pull request. autopilot does not read pull request comments. Close the pull request, then write the correction as a comment on the issue. The host labels the issue `autopilot:blocked` because the pull request closed without a merge. Remove `autopilot:blocked`, and the planner writes a new spec that uses the comment.

### The issue has `autopilot:blocked`

1. Run `autopilot doctor` first. It checks the client, the host and the repo, and prints the command that fixes each problem. It changes nothing.
2. Read the last comment of the bot. It starts with "autopilot stopped:" and gives the reason.
3. Fix the cause. Common reasons:
   - An invalid `.github/autopilot.json`: fix the file on the default branch. A repo with no config at all is not blocked: the host onboards it (see "Onboard a repo with an issue"). "There is no `.github/autopilot.json` on the default branch" means the file was removed during a job: run `autopilot init` and merge its pull request.
   - "The onboarding pull request #N was closed without a merge": retry to open a new one, or run `autopilot init`.
   - "The onboarding failed": read `autopilot logs`, then retry.
   - An invalid config that names `stack`: the config is from an older autopilot. Run `autopilot init` again and merge its pull request.
   - "autopilot does not start the repo's dev container": the comment lists what the guardrails refuse in `.devcontainer/`. Fix the file on the default branch, then retry.
   - "the dev container did not start", or the `install` check fails: fix the image or `postCreateCommand` in `.devcontainer/`.
   - "The planner failed" or "The build failed": the comment gives the reason. Read `autopilot logs` for the agent's output. If it says the token is invalid or expired, replace the Claude token on the host (references/setup.md, section "6. Host"). Then retry.
   - "GitHub refused the merge of #N": a branch protection rule refused the merge. Merge the pull request yourself, or set `merge` to `manual`.
   - "The `secrets` in `.github/autopilot.json` are 1Password references, and this host has no 1Password": set each secret again with `autopilot secrets set <NAME>`, then remove the references from the config.
   - "the builder made no commit": the spec asked for nothing to change, or the builder failed. Make the issue more precise in a comment, then retry.
   - "the change touches `.github/workflows/...`": the App has no Workflows permission, so autopilot cannot change workflow files. Make that change yourself, or add the permission (see "Add the Workflows permission" in references/setup.md). Then retry.
   - "the change touches `.github/workflows/...`, which the approved plan does not list": the App has the Workflows permission, but the plan did not name that file. Add the file to the plan, approve the plan again, or make the change yourself. A plan that lists a workflow file always needs a person's approval.
   - A check "failed twice in a row", or the checks still fail after `limits.fix_rounds` rounds: the comment shows the output. Fix the code or the check command, or make the issue smaller.
   - "Someone who is not an owner changed the issue title or description": an owner edits the text, or removes the `autopilot` label and adds it again. Then retry.
   - "Pull request #N was closed without a merge": comment on the issue to change the plan, then retry.
   - The `secrets` "do not point to this repo's own 1Password item": run `autopilot secrets set --backend op <NAME>` again for each one.
   Errors that reach the user on the command line or in `autopilot logs`, not in a comment:
   - "GitHub refused the App key (401)": the host has the key of another App, or the App was deleted. Replace `app-key.pem` on the host.
   - "rate limit reached, waiting until HH:MM" or "GitHub rate limit reached": the host made too many GitHub requests. It sends no request until that time, then continues. If this occurs frequently, raise `poll_interval_seconds` in its `host.json`, or lower `concurrency`.
   - "The App has no permission for ... (403)": accept the App's new permissions on its installation page.
   - "sudo on <host> asks for a password": let the host user run sudo without a password.
4. Retry: an owner removes the label. `gh issue edit <n> --repo example-org/app --remove-label autopilot:blocked`. Checks and pull requests from before the retry do not count.

### Debug the dev container

Every job runs in the repo's `.devcontainer/`: the install (`postCreateCommand` and the other lifecycle commands), the checks and the builder. Do these steps when a check fails only in autopilot, or when the onboarding pull request shows a check that fails on the default branch:

1. Read the "Environment" and "Checks on the default branch" sections of the onboarding pull request, or the last bot comment of the issue. Then search `autopilot logs` for `owner/repo#n`.
2. Look at `.devcontainer/` on the default branch. `autopilot init` keeps an existing `.devcontainer/` and does not change it. A repo onboarded by an older autopilot has the file of a stack pack, for example `{"name": "node", "image": "node:26.13.1", "workspaceFolder": "/work"}`. It can be out of date: an old image, no `postCreateCommand`, no services. To let the init agent write a new one, delete `.devcontainer/` on the default branch, then run `autopilot init` again. Or fix the file yourself.
3. Start the same environment on your machine. Use the Dev Container CLI version that autopilot pins in its `package.json`:

   ```sh
   npx @devcontainers/cli@0.90.0 up --workspace-folder .
   npx @devcontainers/cli@0.90.0 exec --workspace-folder . sh -c '<the check command>'
   ```

4. Remember what autopilot adds, because a local run does not have it: the user is `root`, the repo is mounted at `workspaceFolder`, memory, CPU and process caps apply, and the network is cut after the install. Only the compose services stay reachable, by their service name. Common causes:
   - A command is not found: install the tool in the image, with a feature, or in `postCreateCommand`.
   - A check downloads something. It fails with no network. Move the download into `postCreateCommand`.
   - A file is not found. The check runs in `workspaceFolder`. Make sure that the path is relative to the repo root.
   - A test cannot reach its database: add the service to the compose file of `.devcontainer/`, with an exact image tag, and use the service name as the host name.
   - A test needs a secret. Add it with `autopilot secrets set <NAME>`. The check commands get the repo's secrets. The install does not.
5. Fix `.devcontainer/` or the check commands in a pull request and merge it. Then run `autopilot init` again. It runs the checks again, writes a new baseline, and updates the same onboarding pull request. For a blocked issue, retry it.

### Stop a job

Remove the trigger label: `gh issue edit <n> --repo example-org/app --remove-label autopilot`. The host stops after the step that runs now. To start again later, add the label again.

### Move an issue to another host

Each host posts a claim comment that starts with `<!-- autopilot:claim host=<name> -->` before it acts. The oldest claim wins, and the other hosts skip the issue. To move the issue, delete the claim comment:

```sh
id=$(gh api "repos/$repo/issues/$n/comments" --paginate --jq '.[] | select(.body | startswith("<!-- autopilot:claim")) | .id' | head -1)
gh api -X DELETE "repos/$repo/issues/comments/$id"
```

The other host must watch the repo.

## Host commands

These commands act on the default host. To act on another host, pass `--host <name>`. The client runs them on the host over SSH.

```sh
autopilot hosts                   # the hosts, and which one is the default
autopilot doctor [--repo example-org/app]   # why it does not work: the client, the host and the repo, with the fix for each problem
autopilot status                  # service, release, watched entries, last 20 log lines
autopilot logs [--since 1h]       # service log, default: last 100 lines
autopilot logs --audit [--since 1d]   # JSON audit events: secret reads, gates, merges
autopilot watch example-org/app   # or a whole account: autopilot watch example-org
autopilot watch example-org/app --remove
autopilot watch                   # list what the host watches
autopilot stop                    # stop the service; autopilot start starts it again
autopilot update [--version vX.Y.Z]
```

`autopilot watch` prints the GitHub App install page and opens it when the App is not installed on that account. The host starts to poll a new entry at the next loop. Each log line names the issue as `owner/repo#n`. Search for it in `autopilot logs` to see what the host did. A line "ignored, the autopilot label was added by X, not an owner" means the wrong account added the label.

## Agents and checks

- Each role (`planner`, `builder`) uses Claude Code by default. To use OpenCode for a role, set `agents.<role>.harness` to `"opencode"` and the model to `<provider>/<model>` in `.github/autopilot.json`, and give the host a provider API key (`autopilot hosts add --api-key <NAME>`). See "Use OpenCode for a role" in references/setup.md.
- By default the host runs the checks (`verify.mode` `host`). With `verify.mode` `ci`, the host waits for the repo's own GitHub Actions jobs, and each name in `verify.required` is a job name. Only a success passes.

## Secrets

A test that needs a key gets it from the repo's secrets. By default, the host keeps them in one env file per repo. In a checkout of the repo:

```sh
autopilot secrets set STRIPE_KEY        # hidden prompt, or the value on stdin
autopilot secrets set --from-env .env   # every key in the file
autopilot secrets list
autopilot secrets rm STRIPE_KEY
```

Pass `--repo <owner>/<repo>` when the checkout is not the repo. A value is never an argument, so ask the user to type it at the prompt. Do not read the `.env` file.

With `--backend op`, the values go to 1Password, with the user's own sign-in. Each value goes to the `autopilot` vault, in the item `<owner>_<repo>`. The command adds the `op://` reference to `.github/autopilot.json`. Commit it and merge it. A reference in the config wins over a value of the same name in the host's file.

Trust boundary: the host gives the values only to the checks that run a command from `verify.commands` (such as `lint`, `types`, `test`). The agents, the scanners and the install step never get them. But a person who can change the code of the repo can read its secrets, for example from a test. Give a repo only test-mode or low-value keys.

## Safety rules

- Only owners count. The host ignores the `autopilot` label when a non-owner added it. It ignores comments from non-owners. It accepts a tick only when all edits of the spec are by owners. It blocks when a non-owner changed the issue title or body after the label.
- Models propose, rules decide. The final risk is the higher of the planner risk and the rule risk. A model can raise the risk, never lower it.
- The builder has no GitHub token. The host pushes the branch and opens the pull request as the App's bot.
- The secrets never go to the agents.
- The agents change GitHub Actions workflows only when the App has the Workflows permission, and only the workflow files in the plan that a person approved. A change in `.github/` is high risk, so a person also reviews each such pull request. Without the permission, the "For a person" section of the spec goes into the pull request body. But a changed workflow runs on the pull request before the review, with the repo's Actions secrets. Keep important secrets in GitHub Environments with required reviewers.

### Risk rules

These always rate a change high, at the plan gate (planned files) and at the merge gate (real diff):

- A path in a directory named `.github`, `.devcontainer`, `.husky`, `.githooks`, `.claude`, `.cursor`, `migrations` or `migrate`.
- `AGENTS.md`, `CLAUDE.md`, `CLAUDE.local.md`, `.mcp.json`, `CODEOWNERS`, `.gitattributes`, `.gitmodules`, `.semgrepignore`, `Makefile`, `justfile`, `mise.toml`, `.mise.toml`.
- Package manifests (`package.json`, `pyproject.toml`, `Cargo.toml`, `go.mod`, `Gemfile`) and lockfiles (`package-lock.json`, `npm-shrinkwrap.json`, `pnpm-lock.yaml`, `yarn.lock`, `bun.lock`, `bun.lockb`, `go.sum`, `Cargo.lock`, `poetry.lock`, `uv.lock`, `Pipfile.lock`, `Gemfile.lock`, `composer.lock`).
- A path with one of these words (split on `/ . - _`, digits and camelCase, plural too): auth, oauth, login, session, token, password, secret, crypto, security, permission, acl, rbac, payment, billing, invoice, checkout, subscription, stripe.
- Terraform (`*.tf`, `*.tfvars`), `Dockerfile*`, `*.Dockerfile`, `compose*.yml`, `docker-compose*.yml`.
- `.env*`, config files (`*.config.*`, `tsconfig*.json`, `.<name>rc` files).
- A deleted file, a binary file, a file that GitHub lists as copied or changed, or a rename from a high-risk path.
- More than `risk.max_diff_lines` changed lines (additions + deletions, default 500).
- A path that matches a glob in `risk.high_paths` of `.github/autopilot.json`.
