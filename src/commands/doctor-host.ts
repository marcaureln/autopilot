import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { parseWatchEntry } from "../core/allow.ts";
import { GRYPE_DB_VOLUME, GRYPE_IMAGE } from "../core/checks.ts";
import { diskVerdict, fail, grypeDbVerdict, memoryVerdict, ok, quotaVerdict, runDoctor, skipped, warn, workflowSecretsVerdict, type Check, type Verdict } from "../core/doctor.ts";
import { createGitHub, type GitHub } from "../core/github.ts";
import { hostSecretFiles, loadHost, secretLabel, type Host } from "../core/host.ts";
import { LOCAL_LAYOUT } from "../core/layout.ts";
import type { Repo } from "../core/repo.ts";
import { readSecret } from "../core/secrets.ts";
import { parseResources, RESOURCES_PROBE } from "../core/setup.ts";
import { checkAppKey, noAudit } from "./client.ts";
import { auditLines, serviceState } from "./host.ts";

type State = { host?: Host; github?: GitHub; installation?: number; repoInstallation?: number };

// `sudo autopilot` runs as root, but the service uses the rootless Docker of its own user.
// A root client can use that socket.
function useServiceDocker(host: Host): void {
  if (LOCAL_LAYOUT.os !== "linux" || process.getuid?.() !== 0 || host.docker === "rootful") return;
  process.env.DOCKER_HOST ??= `unix:///run/user/${execFileSync("id", ["-u", "autopilot"], { encoding: "utf8" }).trim()}/docker.sock`;
}

function dockerFix(host: Host): string {
  if (LOCAL_LAYOUT.os === "darwin") return "start Docker Desktop, or run colima start";
  return host.docker === "rootless" ? "sudo -u autopilot env XDG_RUNTIME_DIR=/run/user/$(id -u autopilot) systemctl --user start docker" : "sudo systemctl start docker";
}

function dockerAnswers(args: string[]): { ok: boolean; output: string } {
  const result = spawnSync("docker", args, { encoding: "utf8" });
  return { ok: result.status === 0, output: (result.stdout + result.stderr).trim().split("\n")[0] ?? "" };
}

const probeResources = () => parseResources(execFileSync("sh", ["-c", RESOURCES_PROBE], { encoding: "utf8" }));

function hostChecks(hostFile: string, repo: Repo | undefined, actionsSecrets: number | undefined): Check[] {
  const state: State = {};
  const withHost = (run: (host: Host) => Promise<Verdict>) => async (): Promise<Verdict> => (state.host ? run(state.host) : skipped("no valid host file"));
  const withApp = (run: (host: Host, github: GitHub) => Promise<Verdict>) => async (): Promise<Verdict> => (state.host && state.github ? run(state.host, state.github) : skipped("no working App key"));

  const checks: Check[] = [
    {
      name: `host file ${hostFile}`,
      run: async () => {
        try {
          state.host = loadHost(hostFile);
          return ok(state.host.name);
        } catch (error) {
          return fail(error instanceof Error ? error.message : String(error), `edit ${hostFile} to match schema/host.schema.json, then run autopilot start`);
        }
      },
    },
    {
      name: "service",
      run: async () => {
        const current = serviceState() || "not installed";
        return ["active", "running"].includes(current) ? ok(current) : fail(`the service is ${current}`, "autopilot start, then read autopilot logs if it stops again");
      },
    },
    {
      name: "docker",
      run: withHost(async (host) => {
        useServiceDocker(host);
        const version = dockerAnswers(["version", "--format", "{{.Server.Version}}"]);
        return version.ok ? ok(version.output) : fail(`docker does not answer: ${version.output}`, dockerFix(host));
      }),
    },
    {
      name: "docker compose",
      run: withHost(async () => {
        const version = dockerAnswers(["compose", "version", "--short"]);
        const install = LOCAL_LAYOUT.os === "darwin" ? "brew install docker-compose" : "sudo apt-get install -y docker-compose-plugin";
        return version.ok ? ok(version.output) : fail(`the Compose plugin does not answer: ${version.output}`, install);
      }),
    },
    { name: "memory", run: withHost(async (host) => memoryVerdict(probeResources().memoryBytes, host.limits.memory, host.concurrency, hostFile)) },
    { name: "disk", run: async () => diskVerdict(probeResources().diskBytes) },
    {
      name: "host secrets",
      run: withHost(async (host) => {
        const files = hostSecretFiles(host.secrets, LOCAL_LAYOUT);
        const stored = (path: string) => existsSync(path) && statSync(path).size > 0;
        const labels = (list: typeof files) => list.map((file) => secretLabel(file.secret)).join(", ");
        const missing = files.filter((file) => !stored(file.path));
        if (missing.length === 0) return ok(`present: ${labels(files) || "none to check, the secrets are in 1Password"}`);
        return fail(`missing on the host: ${labels(missing)}`, `autopilot hosts add ${host.name} <ssh-target>, which pushes what the host lacks`);
      }),
    },
    {
      name: "GitHub App key",
      run: withHost(async (host) => {
        try {
          if (host.secrets.app_key.startsWith("op://")) return skipped("the key is in 1Password, and doctor does not call op");
          const privateKey = readSecret(host.secrets.app_key, "doctor: check the App key", noAudit);
          const { slug } = await checkAppKey(host.app_id, privateKey, "the host");
          state.github = createGitHub({ appId: host.app_id, privateKey }, noAudit);
          return ok(`App ${slug}`);
        } catch (error) {
          return fail(error instanceof Error ? error.message : String(error), `autopilot hosts add ${host.name} <ssh-target> --app-key <pem file>`);
        }
      }),
    },
    {
      name: "watched entries",
      run: withApp(async (host, github) => {
        if (host.allow.length === 0) return warn("the host watches nothing", "autopilot watch <owner>");
        const missing: string[] = [];
        for (const entry of host.allow) {
          const installation = await github.findInstallation(parseWatchEntry(entry));
          if (installation === undefined) missing.push(entry);
          else state.installation ??= installation;
        }
        if (missing.length === 0) return ok(host.allow.join(", "));
        return fail(`the App is not installed for: ${missing.join(", ")}`, missing.map((entry) => `autopilot watch ${entry}`).join("; "));
      }),
    },
  ];

  if (repo) {
    const repoName = `${repo.owner}/${repo.name}`;
    checks.push(
      {
        name: `App installed on ${repoName}`,
        run: withApp(async (_host, github) => {
          state.repoInstallation = await github.findInstallation({ owner: repo.owner, repo: repo.name });
          return state.repoInstallation === undefined ? fail(`the App is not installed on ${repoName}`, `autopilot watch ${repoName}`) : ok();
        }),
      },
      {
        name: "workflow changes before review",
        run: withApp(async (_host, github) => {
          if (state.repoInstallation === undefined) return skipped("the App is not installed on the repo");
          return workflowSecretsVerdict(await github.canChangeWorkflows(state.repoInstallation), actionsSecrets);
        }),
      },
    );
  }

  checks.push(
    {
      name: "Grype database",
      run: async () => {
        // The age comes from the audit trail: reading the database needs a container, and doctor changes nothing.
        const present = dockerAnswers(["image", "inspect", GRYPE_IMAGE]).ok && dockerAnswers(["volume", "inspect", GRYPE_DB_VOLUME]).ok;
        return present ? grypeDbVerdict(auditLines("7d"), Date.now()) : skipped("the host has no Grype image or database yet: the first dependency scan fetches them");
      },
    },
    {
      name: "GitHub rate limit",
      run: withApp(async (_host, github) => {
        const installation = state.repoInstallation ?? state.installation;
        return installation === undefined ? skipped("the App is installed on nothing the host watches") : quotaVerdict(await github.rateLimit(installation));
      }),
    },
  );
  return checks;
}

export async function doctorHost(hostFile: string, repo: Repo | undefined, actionsSecrets: number | undefined): Promise<number> {
  return runDoctor(hostChecks(hostFile, repo, actionsSecrets), console.log);
}
