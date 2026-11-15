#!/usr/bin/env node
import { parseArgs } from "node:util";
import { hostSetup, hostStatus, sshRemote } from "./commands/host.ts";
import { run } from "./commands/run.ts";
import { createGitHub } from "./core/github.ts";
import { loadHost } from "./core/host.ts";
import { parseRepoFlag } from "./core/repo.ts";

const USAGE = `Usage: autopilot <command> [options]

Commands:
  run                         Poll GitHub for autopilot-labeled issues
  host setup <ssh-target>     Install or upgrade autopilot on a host
  host update <ssh-target>    Same as setup
  host status <ssh-target>    Show the service, release and last logs

Options:
  --repo owner/name   Work on this repo instead of the one in the origin remote
  --host <path>       Host file (default ~/.config/autopilot/host.json)
  --once              run: do one loop, then exit`;

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    repo: { type: "string" },
    host: { type: "string" },
    once: { type: "boolean", default: false },
    help: { type: "boolean", short: "h", default: false },
  },
});

async function main(): Promise<void> {
  const [command, subcommand, target] = positionals;
  const only = values.repo ? parseRepoFlag(values.repo) : undefined;
  switch (command) {
    case "run": {
      const host = loadHost(values.host);
      await run(createGitHub(host), host, { once: values.once, only });
      break;
    }
    case "host": {
      if (!target) throw new Error("usage: autopilot host <setup|update|status> <ssh-target>");
      if (subcommand === "setup" || subcommand === "update") {
        await hostSetup(sshRemote(target), loadHost(values.host));
      } else if (subcommand === "status") {
        await hostStatus(sshRemote(target));
      } else {
        throw new Error(`unknown host command: ${subcommand}`);
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
