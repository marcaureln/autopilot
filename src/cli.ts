#!/usr/bin/env node
import { existsSync } from "node:fs";
import { parseArgs, type ParseArgsConfig } from "node:util";
import { unwatch, watch, watched } from "./commands/watch.ts";
import { alias } from "./commands/alias.ts";
import { appCreate } from "./commands/app.ts";
import { forward, hostSetup, selfUpdate } from "./commands/client.ts";
import { init } from "./commands/init.ts";
import { showAudit, showLogs, showStatus, startService, stopService, update } from "./commands/host.ts";
import { run } from "./commands/run.ts";
import { hostSecrets, parseSecretsCommand, secrets, sendSecrets } from "./commands/secrets.ts";
import { setup } from "./commands/setup.ts";
import { auditLog } from "./core/audit.ts";
import { runBuilder } from "./core/builder.ts";
import { grypeDbUpdater, runChecks } from "./core/checks.ts";
import { cliDevcontainer } from "./core/devcontainer-cli.ts";
import { createGitHub } from "./core/github.ts";
import { HOST_FILE, loadHost } from "./core/host.ts";
import { runPlanner } from "./core/planner.ts";
import { detectRepo, type Repo } from "./core/repo.ts";
import { readSecret } from "./core/secrets.ts";

const USAGE = `Usage: autopilot <command> [options]

Commands that run on a host. With --host or AUTOPILOT_HOST, the client forwards them over SSH,
or runs them on this machine for the host "local":
  watch [<owner>[/<repo>]] [--remove]
                              Watch an account, org or repo for issues with the autopilot label. If the App
                              is not installed there, print its install page. --remove stops watching it.
                              With no argument, show what the host watches
  start                       Start the service and show its status
  stop                        Stop the service until the next start or restart of the host
  status                      Show the service, release, watched entries and last logs
  logs [--audit] [--since <time>]
                              Show the service log (default: last 100 lines), or with --audit the audit
                              trail (default: --since 1d)
  update [--version <tag>]    Install a release from GitHub (default: the latest) and restart

Commands that run on the client:
  setup [--config <file> --yes]
                              Set up everything in one wizard: prerequisites, 1Password, the GitHub App, the
                              Claude token, a host, the watched entries, a first repo and the alias. Run it
                              again to fix what is missing. --config gives the answers
                              (schema/setup.schema.json). With --yes, setup asks nothing
  app create [--key-out <path>]
                              Create your GitHub App in the browser (GitHub's App manifest flow). The private
                              key goes to 1Password (vault autopilot), or to a 0600 file with --key-out
  host setup --host <ssh-target | local> [--owner <login> --app-id <id>] [--version <tag> | --from-checkout]
                              Push the 1Password service account token, write host.json if it is
                              missing, and install a release (or the current commit). A Linux host
                              runs a systemd service. A macOS host runs a launchd agent of the user
  init [--skill <source>]... [--notes <file>]
                              Onboard the repo: an agent writes .devcontainer/ (if the repo has none),
                              the check commands and a draft AGENTS.md. Then init checks the dev container,
                              runs the install and each check once, creates the labels and opens a PR.
                              --skill adds a skill (github.com/<owner>/<repo>[//<path>][#<ref>] or a host
                              path) for the agent and for skills.planner and skills.builder. --notes adds
                              your own instructions to the prompt. With a host, also watch the repo there
  secrets set <NAME>          Save a secret of the repo on the host (hidden prompt, or stdin). The checks
                              that run a command get it
  secrets set --from-env <file>
                              The same for every key in a .env file
  secrets list                Show the names of the repo's secrets
  secrets rm <NAME>           Remove a secret
  self-update [--version <tag>]
                              Install a release of this CLI (default: the latest), as install.sh does
  alias [<name>] [--remove]   Add "alias <name>=autopilot" (default: ap) to the rc file of $SHELL

Options:
  --host <ssh-target>  Host to act on, or "local" for this machine (default: $AUTOPILOT_HOST)
  --config <path>      Host file, on the host (default: ${HOST_FILE}). For setup, the setup file
  --repo <owner>/<repo>  Repo of a repo command (default: the origin remote of this checkout)
  --backend env|op     Where secrets go. env (default): an env file per repo on the host.
                       op: 1Password, with a reference in .github/autopilot.json`;

const HOST_COMMANDS = ["watch", "start", "stop", "status", "logs", "update"];

// A typo in an option gets one line and the help hint, not a stack trace.
function parseCommandLine<T extends ParseArgsConfig>(config: T): ReturnType<typeof parseArgs<T>> {
  try {
    return parseArgs(config);
  } catch (error) {
    if (!(error instanceof TypeError) || !("code" in error) || !String(error.code).startsWith("ERR_PARSE_ARGS")) throw error;
    console.error(`${error.message.split(". ")[0]}. Run autopilot --help.`);
    process.exit(1);
  }
}

const { values, positionals } = parseCommandLine({
  allowPositionals: true,
  options: {
    host: { type: "string" },
    config: { type: "string" },
    once: { type: "boolean", default: false },
    foreground: { type: "boolean", default: false },
    audit: { type: "boolean", default: false },
    since: { type: "string" },
    version: { type: "string" },
    owner: { type: "string" },
    "app-id": { type: "string" },
    "from-checkout": { type: "boolean", default: false },
    repo: { type: "string" },
    backend: { type: "string", default: "env" },
    "from-env": { type: "string" },
    skill: { type: "string", multiple: true, default: [] },
    notes: { type: "string" },
    remove: { type: "boolean", default: false },
    "key-out": { type: "string" },
    yes: { type: "boolean", default: false },
    help: { type: "boolean", short: "h", default: false },
  },
});

function hostTarget(): string | undefined {
  const target = values.host ?? process.env.AUTOPILOT_HOST;
  if (target?.startsWith("-")) throw new Error(`"${target}" is not an SSH target`);
  return target;
}

function targetRepo(): Repo {
  if (values.repo === undefined) return detectRepo();
  const [owner, name, ...rest] = values.repo.split("/");
  if (!owner || !name || rest.length > 0) throw new Error(`--repo "${values.repo}" is not <owner>/<repo>`);
  return { owner, name };
}

async function main(): Promise<void> {
  const [command = ""] = positionals;
  const target = hostTarget();
  const hostFile = values.config ?? HOST_FILE;
  // The service runs `start --foreground` on the host itself: never forwarded.
  if (HOST_COMMANDS.includes(command) && !(command === "start" && values.foreground)) {
    if (target) {
      const options = [
        ...(values.since ? ["--since", values.since] : []),
        ...(values.version ? ["--version", values.version] : []),
        ...(values.remove ? ["--remove"] : []),
        ...(values.audit ? ["--audit"] : []),
      ];
      process.exitCode = await forward(target, [...positionals, ...options]);
      return;
    }
    if (!existsSync(hostFile)) throw new Error(`no host file at ${hostFile}: to manage a host, set AUTOPILOT_HOST=<ssh-target | local> or pass --host`);
  }
  switch (command) {
    case "start": {
      if (!values.foreground) {
        startService();
        showStatus(hostFile);
        break;
      }
      const host = loadHost(hostFile);
      const privateKey = readSecret(host.secrets.app_key, "start: GitHub App key", auditLog);
      const claudeToken = readSecret(host.secrets.claude_token, "start: token for the agent containers", auditLog);
      const github = createGitHub({ appId: host.app_id, privateKey }, auditLog);
      await run(
        {
          github,
          host,
          audit: auditLog,
          idle: grypeDbUpdater(host.limits, auditLog),
          plan: (job) => runPlanner(job, { claudeToken, audit: auditLog }),
          build: (job) => runBuilder({ ...job, claudeToken, devcontainer: cliDevcontainer, audit: auditLog }),
          check: (job) => runChecks({ ...job, devcontainer: cliDevcontainer, audit: auditLog }),
        },
        { once: values.once },
      );
      break;
    }
    case "stop":
      stopService();
      break;
    case "watch": {
      const entry = positionals[1];
      if (entry === undefined) watched(hostFile);
      else if (values.remove) unwatch(hostFile, entry, auditLog);
      else await watch(hostFile, entry, auditLog);
      break;
    }
    case "status":
      showStatus(hostFile);
      break;
    case "logs":
      if (values.audit) showAudit(values.since);
      else showLogs(values.since);
      break;
    case "update":
      await update(hostFile, values.version);
      break;
    case "init":
      await init({ repo: targetRepo(), host: target, skills: values.skill, notesFile: values.notes });
      break;
    case "secrets": {
      const command = parseSecretsCommand(positionals.slice(1), values["from-env"]);
      if (values.backend === "op") await secrets(command, targetRepo());
      else if (values.backend !== "env") throw new Error(`--backend ${values.backend} is not a backend: env (the default) or op`);
      // `import` is what the client sends: it always runs here, on the host.
      else if (target && command.action !== "import") process.exitCode = await sendSecrets(target, command, targetRepo());
      else if (!existsSync(hostFile)) throw new Error("the env backend keeps the secrets on a host: pass --host or set AUTOPILOT_HOST");
      else await hostSecrets(command, targetRepo(), auditLog);
      break;
    }
    case "host": {
      if (positionals[1] !== "setup" || !target) throw new Error("usage: autopilot host setup --host <ssh-target | local> [--owner <login> --app-id <id>]");
      const appId = values["app-id"] === undefined ? undefined : Number(values["app-id"]);
      if (appId !== undefined && !Number.isInteger(appId)) throw new Error(`--app-id "${values["app-id"]}" is not a number`);
      await hostSetup(target, { owner: values.owner, appId, version: values.version, fromCheckout: values["from-checkout"] });
      break;
    }
    case "setup":
      await setup({ configFile: values.config, yes: values.yes, host: target, version: values.version, fromCheckout: values["from-checkout"] });
      break;
    case "app":
      if (positionals[1] !== "create" || positionals.length > 2) throw new Error("usage: autopilot app create [--key-out <path>]");
      await appCreate({ keyOut: values["key-out"] });
      break;
    case "self-update":
      await selfUpdate(values.version);
      break;
    case "alias":
      alias(positionals[1], values.remove);
      break;
    default:
      console.log(USAGE);
      process.exitCode = values.help ? 0 : 1;
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
