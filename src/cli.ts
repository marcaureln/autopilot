#!/usr/bin/env node
import { existsSync } from "node:fs";
import { parseArgs, type ParseArgsConfig } from "node:util";
import { unwatch, watch, watched } from "./commands/watch.ts";
import { alias } from "./commands/alias.ts";
import { appCreate } from "./commands/app.ts";
import { clientClaudeToken, forward, readAppKey, readClaudeToken, selfUpdate, type HostSetupOptions } from "./commands/client.ts";
import { init } from "./commands/init.ts";
import { showAudit, showLogs, showStatus, startService, stopService, update } from "./commands/host.ts";
import { findHost, hostsAdd, hostsDefault, hostsRemove, HOSTS_USAGE, listHosts, nameToSave } from "./commands/hosts.ts";
import { run } from "./commands/run.ts";
import { hostSecrets, parseSecretsCommand, secrets, sendSecrets } from "./commands/secrets.ts";
import { setup } from "./commands/setup.ts";
import { auditLog, serviceLog } from "./core/audit.ts";
import { runBuilder } from "./core/builder.ts";
import { grypeDbUpdater, runChecks } from "./core/checks.ts";
import { cliDevcontainer } from "./core/devcontainer-cli.ts";
import { createGitHub } from "./core/github.ts";
import { runOnboarder } from "./core/onboarder.ts";
import { HOST_FILE, loadHost } from "./core/host.ts";
import type { HostRef } from "./core/hosts.ts";
import { runPlanner } from "./core/planner.ts";
import { detectRepo, type Repo } from "./core/repo.ts";
import { readSecret, type Backend } from "./core/secrets.ts";

const USAGE = `Usage: autopilot <command> [options]

Commands that run on a host. The client forwards them over SSH to the host of --host, else of
AUTOPILOT_HOST, else to the default host of the hosts file. For the target "local", they run on this machine:
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
  setup [--config <file> --yes] [--backend op]
                              Set up everything in one wizard: prerequisites, the GitHub App, a host and its
                              secrets, the watched entries, a first repo and the alias. With no --host, it
                              uses the default host. It saves the host in the hosts file, under --name. Run it again to fix what is missing. --config gives the answers
                              (schema/setup.schema.json). With --yes, setup asks nothing. With --backend op,
                              the secrets go to 1Password
  app create [--key-out <path> | --backend op]
                              Create your GitHub App in the browser (GitHub's App manifest flow). The private
                              key goes to a 0600 file: ~/.config/autopilot/app-key.pem, where hosts add finds
                              it, or the --key-out path. With --backend op, it goes to 1Password (vault autopilot)
  hosts                       Show the hosts of the hosts file and which one is the default
  hosts add <name> <ssh-target | local> [--owner <login> --app-id <id>] [--app-key <pem file>]
            [--version <tag> | --from-checkout]
                              Write host.json if it is missing, install a release (or the current commit),
                              and push each host secret that the host does not have: the App key (--app-key,
                              else the key that app create saved) and the Claude token ($CLAUDE_CODE_OAUTH_TOKEN,
                              else a hidden prompt). Then save the host in the hosts file. The first host saved
                              becomes the default. A Linux host runs a systemd service. A macOS host runs a
                              launchd agent of the user. The SSH target can be a Host alias of ~/.ssh/config
  hosts rm <name>             Remove a host from the hosts file. It does not uninstall autopilot on the host
  hosts default <name>        Make a host the default host
  init [--skill <source>]... [--notes <file>]
                              Onboard the repo: an agent writes .devcontainer/ (if the repo has none),
                              the check commands and a draft AGENTS.md. Then init checks the dev container,
                              runs the install and each check once, creates the labels and opens a PR.
                              --skill adds a skill (github.com/<owner>/<repo>[//<path>][#<ref>] or a host
                              path) for the agent and for skills.planner and skills.builder. --notes adds
                              your own instructions to the prompt. With a host, also watch the repo there.
                              The agent uses the Claude token in $CLAUDE_CODE_OAUTH_TOKEN, else asks for it
                              (with --backend op, it reads it from 1Password)
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
  --host <name | ssh-target>
                       Host to act on: a name of the hosts file, an SSH target, or "local" for this machine
                       (default: $AUTOPILOT_HOST, else the default host of the hosts file)
  --name <name>        Name to save the host under, for setup and host setup (default: the host part of
                       its SSH target, or the short hostname for "local")
  --config <path>      Host file, on the host (default: ${HOST_FILE}). For setup, the setup file
  --repo <owner>/<repo>  Repo of a repo command (default: the origin remote of this checkout)
  --backend env|op     Where secrets go. env (default): files on the host. op: 1Password, with op://
                       references in host.json and .github/autopilot.json

The hosts file is ~/.config/autopilot/hosts.json ($XDG_CONFIG_HOME/autopilot/hosts.json). It holds no secret.`;

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
    name: { type: "string" },
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
    backend: { type: "string" },
    "from-env": { type: "string" },
    skill: { type: "string", multiple: true, default: [] },
    notes: { type: "string" },
    remove: { type: "boolean", default: false },
    "key-out": { type: "string" },
    "app-key": { type: "string" },
    yes: { type: "boolean", default: false },
    help: { type: "boolean", short: "h", default: false },
  },
});

function selectedHost(): HostRef | undefined {
  return findHost(values.host, process.env.AUTOPILOT_HOST);
}

function hostSetupOptions(): HostSetupOptions {
  const appId = values["app-id"] === undefined ? undefined : Number(values["app-id"]);
  if (appId !== undefined && !Number.isInteger(appId)) throw new Error(`--app-id "${values["app-id"]}" is not a number`);
  const interactive = process.stdin.isTTY;
  const sources = { app_key: () => readAppKey(values["app-key"], interactive), claude_token: () => readClaudeToken(interactive) };
  return { owner: values.owner, appId, version: values.version, fromCheckout: values["from-checkout"], backend: secretsBackend(), sources };
}

function secretsBackend(): Backend {
  const backend = values.backend ?? "env";
  if (backend !== "env" && backend !== "op") throw new Error(`--backend ${backend} is not a backend: env (the default) or op`);
  return backend;
}

function targetRepo(): Repo {
  if (values.repo === undefined) return detectRepo();
  const [owner, name, ...rest] = values.repo.split("/");
  if (!owner || !name || rest.length > 0) throw new Error(`--repo "${values.repo}" is not <owner>/<repo>`);
  return { owner, name };
}

async function main(): Promise<void> {
  const [command = ""] = positionals;
  const hostFile = values.config ?? HOST_FILE;
  // The service runs `start --foreground` on the host itself: never forwarded.
  if (HOST_COMMANDS.includes(command) && !(command === "start" && values.foreground)) {
    const target = selectedHost()?.target;
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
    if (!existsSync(hostFile)) throw new Error(`no host file at ${hostFile}: add a host with autopilot hosts add <name> <ssh-target | local>, or pass --host`);
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
      const credentials = {
        claudeToken: readSecret(host.secrets.claude_token, "start: token for the agent containers", auditLog),
        apiKeys: Object.fromEntries(Object.entries(host.secrets.api_keys ?? {}).map(([name, reference]) => [name, readSecret(reference, `start: ${name} for the agent containers`, auditLog)])),
      };
      const github = createGitHub({ appId: host.app_id, privateKey }, auditLog);
      await run(
        {
          github,
          host,
          audit: auditLog,
          idle: grypeDbUpdater(host.limits, auditLog),
          plan: (job) => runPlanner(job, { credentials, audit: auditLog }),
          build: (job) => runBuilder({ ...job, credentials, devcontainer: cliDevcontainer, audit: auditLog }),
          check: (job) => runChecks({ ...job, devcontainer: cliDevcontainer, audit: auditLog }),
          onboard: (job) => runOnboarder({ ...job, credentials, devcontainer: cliDevcontainer, audit: auditLog, say: (line) => serviceLog(`${job.repo.owner}/${job.repo.name}: ${line}`) }),
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
    case "init": {
      const backend = secretsBackend();
      await init({ repo: targetRepo(), host: selectedHost()?.target, skills: values.skill, notesFile: values.notes, claudeToken: () => clientClaudeToken(backend, process.stdin.isTTY) });
      break;
    }
    case "secrets": {
      const command = parseSecretsCommand(positionals.slice(1), values["from-env"]);
      if (secretsBackend() === "op") {
        await secrets(command, targetRepo());
        break;
      }
      const target = selectedHost()?.target;
      // `import` is what the client sends: it always runs here, on the host.
      if (target && command.action !== "import") process.exitCode = await sendSecrets(target, command, targetRepo());
      else if (!existsSync(hostFile)) throw new Error("the env backend keeps the secrets on a host: add a host with autopilot hosts add, or pass --host");
      else await hostSecrets(command, targetRepo(), auditLog);
      break;
    }
    case "hosts": {
      const [, action, name, target, ...rest] = positionals;
      if (action === undefined) listHosts();
      else if (action === "add" && name && target && rest.length === 0) await hostsAdd(name, target, hostSetupOptions());
      else if (action === "rm" && name && target === undefined) hostsRemove(name);
      else if (action === "default" && name && target === undefined) hostsDefault(name);
      else throw new Error(HOSTS_USAGE);
      break;
    }
    case "host": {
      const named = positionals[1] === "setup" ? selectedHost() : undefined;
      if (!named) throw new Error("usage: autopilot hosts add <name> <ssh-target | local> [--owner <login> --app-id <id>] [--app-key <pem file>]");
      const name = nameToSave(named, values.name);
      console.log(`note: autopilot hosts add ${name} ${named.target} replaces host setup`);
      await hostsAdd(name, named.target, hostSetupOptions());
      break;
    }
    case "setup":
      await setup({ configFile: values.config, yes: values.yes, host: values.host, name: values.name, version: values.version, fromCheckout: values["from-checkout"], backend: values.backend === undefined ? undefined : secretsBackend(), appKey: values["app-key"] });
      break;
    case "app":
      if (positionals[1] !== "create" || positionals.length > 2) throw new Error("usage: autopilot app create [--key-out <path> | --backend op]");
      await appCreate({ keyOut: values["key-out"], backend: secretsBackend() });
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
  // `fetch failed` and similar errors say why only in the cause.
  if (error instanceof Error && error.cause) console.error(String(error.cause).slice(-2000));
  process.exitCode = 1;
});
