#!/usr/bin/env node
import { existsSync } from "node:fs";
import { parseArgs } from "node:util";
import { allow, allowed, deny } from "./commands/allow.ts";
import { alias } from "./commands/alias.ts";
import { appCreate } from "./commands/app.ts";
import { forward, hostSetup, selfUpdate } from "./commands/client.ts";
import { init } from "./commands/init.ts";
import { showAudit, showLogs, showStatus, update } from "./commands/host.ts";
import { run } from "./commands/run.ts";
import { parseSecretsCommand, secrets } from "./commands/secrets.ts";
import { setup } from "./commands/setup.ts";
import { auditLog } from "./core/audit.ts";
import { runBuilder } from "./core/builder.ts";
import { runChecks } from "./core/checks.ts";
import { createGitHub } from "./core/github.ts";
import { HOST_FILE, loadHost } from "./core/host.ts";
import { runPlanner } from "./core/planner.ts";
import { detectRepo, type Repo } from "./core/repo.ts";
import { readSecret } from "./core/secrets.ts";

const USAGE = `Usage: autopilot <command> [options]

Commands that run on a host. With --host or AUTOPILOT_HOST, the client forwards them over SSH,
or runs them on this machine for the host "local":
  allow <owner>[/<repo>]      Allow it; prints the App install page if the App is not installed there
  deny <owner>[/<repo>]       Remove it from the allowlist
  allowed                     Show the allowlist
  status                      Show the service, release, allowlist and last logs
  logs [--since <time>]       Show the service log (default: last 100 lines)
  audit [--since <time>]      Show the audit trail (default: --since 1d)
  update [--version <tag>]    Install a release from GitHub (default: the latest) and restart
  run [--once]                Plan, build, check and merge autopilot-labeled issues, one job at a time (never forwarded)

Commands that run on the client:
  setup [--config <file> --yes]
                              Set up everything in one wizard: prerequisites, 1Password, the GitHub App, the
                              Claude token, a host, the allowlist, a first repo and the alias. Run it again to
                              fix what is missing. --config gives the answers (schema/setup.schema.json);
                              with --yes, setup asks nothing
  app create [--key-out <path>]
                              Create your GitHub App in the browser (GitHub's App manifest flow). The private
                              key goes to 1Password (vault autopilot), or to a 0600 file with --key-out
  host setup --host <ssh-target | local> [--owner <login> --app-id <id>] [--version <tag> | --from-checkout]
                              Push the 1Password service account token, write host.json if it is
                              missing, and install a release (or the current commit). Linux hosts
                              run a systemd service, macOS hosts a launchd agent of the user
  init [--no-agent]           Onboard the repo: scaffold the stack pack, create the labels, let an agent
                              set the commands and draft AGENTS.md, run the checks once, and open a PR.
                              With a host, also allow the repo there
  secrets set <NAME>          Save a secret in 1Password (hidden prompt, or stdin) and add its reference
                              to .github/autopilot.json in this checkout
  secrets set --from-env <file>
                              The same for every key in a .env file
  secrets list                Show the secrets of the repo
  secrets rm <NAME>           Remove a secret and its reference
  self-update [--version <tag>]
                              Install a release of this CLI (default: the latest), as install.sh does
  alias [<name>] [--remove]   Add "alias <name>=autopilot" (default: ap) to the rc file of $SHELL

Options:
  --host <ssh-target>  Host to act on, or "local" for this machine (default: $AUTOPILOT_HOST)
  --config <path>      Host file, on the host (default: ${HOST_FILE}); for setup, the setup file
  --repo <owner>/<repo>  Repo of a repo command (default: the origin remote of this checkout)
  --backend op         Where secrets are saved (default and only one: op, the 1Password CLI)`;

const HOST_COMMANDS = ["allow", "deny", "allowed", "status", "logs", "audit", "update"];

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    host: { type: "string" },
    config: { type: "string" },
    once: { type: "boolean", default: false },
    since: { type: "string" },
    version: { type: "string" },
    owner: { type: "string" },
    "app-id": { type: "string" },
    "from-checkout": { type: "boolean", default: false },
    repo: { type: "string" },
    backend: { type: "string", default: "op" },
    "from-env": { type: "string" },
    "no-agent": { type: "boolean", default: false },
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

function argument(command: string): string {
  const value = positionals[1];
  if (!value) throw new Error(`usage: autopilot ${command} <owner>[/<repo>]`);
  return value;
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
  if (HOST_COMMANDS.includes(command)) {
    if (target) {
      const options = [...(values.since ? ["--since", values.since] : []), ...(values.version ? ["--version", values.version] : [])];
      process.exitCode = await forward(target, [...positionals, ...options]);
      return;
    }
    if (!existsSync(hostFile)) throw new Error(`no host file at ${hostFile}: to manage a host, set AUTOPILOT_HOST=<ssh-target | local> or pass --host`);
  }
  switch (command) {
    case "run": {
      const host = loadHost(hostFile);
      const privateKey = readSecret(host.secrets.app_key, "run: GitHub App key", auditLog);
      const claudeToken = readSecret(host.secrets.claude_token, "run: token for the agent containers", auditLog);
      const github = createGitHub({ appId: host.app_id, privateKey }, auditLog);
      await run(
        {
          github,
          host,
          audit: auditLog,
          plan: (job) => runPlanner(job, { claudeToken, audit: auditLog }),
          build: (job) => runBuilder({ ...job, claudeToken, audit: auditLog }),
          check: (job) => runChecks({ ...job, audit: auditLog }),
        },
        { once: values.once },
      );
      break;
    }
    case "allow":
      await allow(hostFile, argument(command), auditLog);
      break;
    case "deny":
      deny(hostFile, argument(command), auditLog);
      break;
    case "allowed":
      allowed(hostFile);
      break;
    case "status":
      showStatus(hostFile);
      break;
    case "logs":
      showLogs(values.since);
      break;
    case "audit":
      showAudit(values.since);
      break;
    case "update":
      await update(hostFile, values.version);
      break;
    case "init":
      await init({ repo: targetRepo(), host: target, agent: !values["no-agent"] });
      break;
    case "secrets": {
      if (values.backend !== "op") throw new Error(`--backend ${values.backend} is not supported: the only backend is op (1Password)`);
      await secrets(parseSecretsCommand(positionals.slice(1), values["from-env"]), targetRepo());
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
      if (positionals[1] !== "create") throw new Error("usage: autopilot app create [--key-out <path>]");
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
