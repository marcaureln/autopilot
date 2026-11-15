#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { allow, deny, listAllowed, type Hosts } from "./commands/allow.ts";
import { hostSetup, hostStatus, localAccess, remoteAccess, sshRemote, type HostAccess } from "./commands/host.ts";
import { run } from "./commands/run.ts";
import { loadClient, type Client } from "./core/client.ts";
import { createGitHub } from "./core/github.ts";
import { loadHost } from "./core/host.ts";
import { runPlanner } from "./core/planner.ts";

const USAGE = `Usage: autopilot <command> [options]

Commands:
  run                          Plan autopilot-labeled issues, one job at a time
  allow <owner>[/<repo>]       Allow it on a host; opens the App install page if needed
  deny <owner>[/<repo>]        Remove it from a host allowlist
  allowed                      List the allowlist of every host
  host setup                   Install or upgrade autopilot on a host
  host update                  Same as setup
  host status                  Show the service, release, allowlist and last logs

Hosts are named in ~/.config/autopilot/config.json.

Options:
  --on <host>         Host name to act on (default: default_host)
  --host <path>       run: host file (default ~/.config/autopilot/host.json)
  --once              run: do one loop, then exit`;

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    host: { type: "string" },
    on: { type: "string" },
    once: { type: "boolean", default: false },
    help: { type: "boolean", short: "h", default: false },
  },
});

function accessTo(target: string): HostAccess {
  return target === "local" ? localAccess() : remoteAccess(sshRemote(target));
}

function hostsOf(client: Client): Hosts {
  return new Map(Object.entries(client.hosts).map(([name, target]) => [name, accessTo(target)]));
}

function sshTargetOf(client: Client, name: string): string {
  const target = client.hosts[name];
  if (!target) throw new Error(`unknown host ${name}`);
  if (target === "local") throw new Error("host setup on this machine comes with step 3b");
  return target;
}

async function main(): Promise<void> {
  const [command, argument] = positionals;
  switch (command) {
    case "run": {
      const host = loadHost(values.host);
      const github = createGitHub({ appId: host.app_id, privateKey: readFileSync(host.private_key_path, "utf8") });
      await run({ github, host, plan: runPlanner }, { once: values.once });
      break;
    }
    case "allow":
    case "deny": {
      if (!argument) throw new Error(`usage: autopilot ${command} <owner>[/<repo>]`);
      const client = loadClient();
      const target = values.on ?? client.default_host;
      await (command === "allow" ? allow(hostsOf(client), target, client, argument) : deny(hostsOf(client), target, argument));
      break;
    }
    case "allowed":
      await listAllowed(hostsOf(loadClient()));
      break;
    case "host": {
      const client = loadClient();
      const target = sshTargetOf(client, values.on ?? client.default_host);
      if (argument === "setup" || argument === "update") {
        await hostSetup(sshRemote(target), client);
      } else if (argument === "status") {
        await hostStatus(sshRemote(target));
      } else {
        throw new Error("usage: autopilot host <setup|update|status> [--on <host>]");
      }
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
