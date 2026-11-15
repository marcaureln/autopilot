#!/usr/bin/env node
import { parseArgs } from "node:util";
import { allow, deny, listAllowed } from "./commands/allow.ts";
import { hostSetup, hostStatus, localAccess, remoteAccess, sshRemote, type HostAccess } from "./commands/host.ts";
import { run } from "./commands/run.ts";
import { loadClient } from "./core/client.ts";
import { createGitHub } from "./core/github.ts";
import { loadHost } from "./core/host.ts";

const USAGE = `Usage: autopilot <command> [options]

Commands:
  run                          Poll GitHub for autopilot-labeled issues
  allow <owner>[/<repo>]       Open the App install page and allow it on the host
  deny <owner>[/<repo>]        Remove it from the host allowlist
  allowed                      List the host allowlist
  host setup [ssh-target]      Install or upgrade autopilot on the host
  host update [ssh-target]     Same as setup
  host status [ssh-target]     Show the service, release, allowlist and last logs

The host is the "host" field of ~/.config/autopilot/config.json unless a target is given.

Options:
  --host <path>       run: host file (default ~/.config/autopilot/host.json)
  --once              run: do one loop, then exit`;

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    host: { type: "string" },
    once: { type: "boolean", default: false },
    help: { type: "boolean", short: "h", default: false },
  },
});

function accessTo(target: string): HostAccess {
  return target === "local" ? localAccess() : remoteAccess(sshRemote(target));
}

async function main(): Promise<void> {
  const [command, argument, extra] = positionals;
  switch (command) {
    case "run": {
      const host = loadHost(values.host);
      await run(createGitHub(host), host, { once: values.once });
      break;
    }
    case "allow":
    case "deny": {
      if (!argument) throw new Error(`usage: autopilot ${command} <owner>[/<repo>]`);
      const client = loadClient();
      const access = accessTo(client.host);
      await (command === "allow" ? allow(access, client, argument) : deny(access, argument));
      break;
    }
    case "allowed":
      await listAllowed(accessTo(loadClient().host));
      break;
    case "host": {
      const client = loadClient();
      const target = extra ?? client.host;
      if (target === "local") throw new Error("host setup on this machine comes with step 3b");
      if (argument === "setup" || argument === "update") {
        await hostSetup(sshRemote(target), client);
      } else if (argument === "status") {
        await hostStatus(sshRemote(target));
      } else {
        throw new Error("usage: autopilot host <setup|update|status> [ssh-target]");
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
