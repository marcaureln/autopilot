#!/usr/bin/env node
import { existsSync } from "node:fs";
import { parseArgs } from "node:util";
import { allow, allowed, deny } from "./commands/allow.ts";
import { forward, hostSetup } from "./commands/client.ts";
import { showAudit, showLogs, showStatus, update } from "./commands/host.ts";
import { run } from "./commands/run.ts";
import { parseSecretsCommand, secrets } from "./commands/secrets.ts";
import { auditLog } from "./core/audit.ts";
import { runBuilder } from "./core/builder.ts";
import { runChecks } from "./core/checks.ts";
import { createGitHub } from "./core/github.ts";
import { HOST_FILE, loadHost } from "./core/host.ts";
import { runPlanner } from "./core/planner.ts";
import { detectRepo, type Repo } from "./core/repo.ts";
import { readSecret } from "./core/secrets.ts";

const USAGE = `Usage: autopilot <command> [options]

Commands that run on a host. With --host or AUTOPILOT_HOST, the client forwards them over SSH:
  allow <owner>[/<repo>]      Allow it; prints the App install page if the App is not installed there
  deny <owner>[/<repo>]       Remove it from the allowlist
  allowed                     Show the allowlist
  status                      Show the service, release, allowlist and last logs
  logs [--since <time>]       Show the service log (default: last 100 lines)
  audit [--since <time>]      Show the audit trail (default: --since 1d)
  update [--version <tag>]    Install a release from GitHub (default: the latest) and restart
  run [--once]                Plan, build, check and merge autopilot-labeled issues, one job at a time (never forwarded)

Commands that run on the client:
  host setup --host <ssh-target> [--owner <login> --app-id <id>] [--version <tag> | --from-checkout]
                              Push the 1Password service account token, write host.json if it is
                              missing, and install a release (or the current commit)
  secrets set <NAME>          Save a secret in 1Password (hidden prompt, or stdin) and add its reference
                              to .github/autopilot.json in this checkout
  secrets set --from-env <file>
                              The same for every key in a .env file
  secrets list                Show the secrets of the repo
  secrets rm <NAME>           Remove a secret and its reference

Options:
  --host <ssh-target>  Host to act on (default: $AUTOPILOT_HOST)
  --config <path>      Host file, on the host (default: ${HOST_FILE})
  --repo <owner>/<repo>  Repo of a repo command (default: the origin remote of this checkout)
  --backend op         Where secrets are saved (default and only one: op, the 1Password CLI)`;

const HOST_COMMANDS = ["allow", "deny", "allowed", "status", "logs", "audit", "update"];

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    host: { type: "string" },
    config: { type: "string", default: HOST_FILE },
    once: { type: "boolean", default: false },
    since: { type: "string" },
    version: { type: "string" },
    owner: { type: "string" },
    "app-id": { type: "string" },
    "from-checkout": { type: "boolean", default: false },
    repo: { type: "string" },
    backend: { type: "string", default: "op" },
    "from-env": { type: "string" },
    help: { type: "boolean", short: "h", default: false },
  },
});

function sshTarget(): string | undefined {
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
  const target = sshTarget();
  if (HOST_COMMANDS.includes(command)) {
    if (target) {
      const options = [...(values.since ? ["--since", values.since] : []), ...(values.version ? ["--version", values.version] : [])];
      process.exitCode = await forward(target, [...positionals, ...options]);
      return;
    }
    if (!existsSync(values.config)) throw new Error(`no host file at ${values.config}: to manage a host, set AUTOPILOT_HOST=<ssh-target> or pass --host`);
  }
  switch (command) {
    case "run": {
      const host = loadHost(values.config);
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
      await allow(values.config, argument(command), auditLog);
      break;
    case "deny":
      deny(values.config, argument(command), auditLog);
      break;
    case "allowed":
      allowed(values.config);
      break;
    case "status":
      showStatus(values.config);
      break;
    case "logs":
      showLogs(values.since);
      break;
    case "audit":
      showAudit(values.since);
      break;
    case "update":
      await update(values.config, values.version);
      break;
    case "secrets": {
      if (values.backend !== "op") throw new Error(`--backend ${values.backend} is not supported: the only backend is op (1Password)`);
      await secrets(parseSecretsCommand(positionals.slice(1), values["from-env"]), targetRepo());
      break;
    }
    case "host": {
      if (positionals[1] !== "setup" || !target) throw new Error("usage: autopilot host setup --host <ssh-target> [--owner <login> --app-id <id>]");
      const appId = values["app-id"] === undefined ? undefined : Number(values["app-id"]);
      if (appId !== undefined && !Number.isInteger(appId)) throw new Error(`--app-id "${values["app-id"]}" is not a number`);
      await hostSetup(target, { owner: values.owner, appId, version: values.version, fromCheckout: values["from-checkout"] });
      break;
    }
    default:
      console.log(USAGE);
      process.exitCode = values.help ? 0 : 1;
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
