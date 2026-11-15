import { setTimeout as sleep } from "node:timers/promises";
import type { GitHub } from "../core/github.ts";
import type { Host } from "../core/host.ts";
import type { Repo } from "../core/repo.ts";

const TRIGGER_LABEL = "autopilot";

export async function runOnce(github: GitHub, host: Host, only: Repo | undefined, log: (line: string) => void): Promise<void> {
  for (const installation of await github.listInstallations()) {
    if (!host.installations.includes(installation.account)) {
      log(`ignoring installation ${installation.id} (${installation.account}): not in installations`);
      continue;
    }
    for (const repo of await github.listRepos(installation.id)) {
      if (only && (repo.owner !== only.owner || repo.name !== only.name)) continue;
      for (const issue of await github.listLabeledIssues(installation.id, repo, TRIGGER_LABEL)) {
        log(`${repo.owner}/${repo.name}#${issue.number} ${JSON.stringify(issue.title)}`);
      }
    }
  }
}

export async function run(github: GitHub, host: Host, options: { once: boolean; only?: Repo }): Promise<void> {
  const log = (line: string) => console.log(line);
  await runOnce(github, host, options.only, log);
  while (!options.once) {
    await sleep(host.poll_interval_seconds * 1000);
    await runOnce(github, host, options.only, log);
  }
}
