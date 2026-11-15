import { setTimeout as sleep } from "node:timers/promises";
import { parseAllowEntry } from "../core/allow.ts";
import type { GitHub } from "../core/github.ts";
import type { Host } from "../core/host.ts";

const TRIGGER_LABEL = "autopilot";

export async function runOnce(github: GitHub, host: Host, log: (line: string) => void): Promise<void> {
  for (const value of host.allow) {
    const entry = parseAllowEntry(value);
    const installationId = await github.findInstallation(entry);
    if (installationId === undefined) {
      log(`not installed: ${value}`);
      continue;
    }
    const repos = entry.repo ? [{ owner: entry.owner, name: entry.repo }] : await github.listRepos(installationId, entry.owner);
    for (const repo of repos) {
      for (const issue of await github.listLabeledIssues(installationId, repo, TRIGGER_LABEL)) {
        log(`${repo.owner}/${repo.name}#${issue.number} ${JSON.stringify(issue.title)}`);
      }
    }
  }
}

export async function run(github: GitHub, host: Host, options: { once: boolean }): Promise<void> {
  const log = (line: string) => console.log(line);
  await runOnce(github, host, log);
  while (!options.once) {
    await sleep(host.poll_interval_seconds * 1000);
    await runOnce(github, host, log);
  }
}
