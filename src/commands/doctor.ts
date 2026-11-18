import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { CONFIG_PATH, parseConfig, type Config } from "../core/config.ts";
import { cliDevcontainer } from "../core/devcontainer-cli.ts";
import { CHECKS_FAILED, checkCommandsVerdict, ciJobsVerdict, fail, formatResult, labelsVerdict, ok, releaseVerdict, runDoctor, skipped, workflowJobNames, type Check, type Verdict } from "../core/doctor.ts";
import { EnvironmentRefused, inspectEnvironment } from "../core/environment.ts";
import type { HostRef } from "../core/hosts.ts";
import type { Repo } from "../core/repo.ts";
import { installCommand, releaseId, RELEASE_TAG, requiredTools } from "../core/setup.ts";
import { found, forward } from "./client.ts";
import { doctorHost } from "./doctor-host.ts";
import { reach, type Connection } from "./host.ts";
import { HOSTS_PATH, loadHosts } from "./hosts.ts";

export type DoctorOptions = { hostFile: string; host: () => HostRef | undefined; repo: Repo | undefined };

const CLI_ROOT = new URL("../../", import.meta.url).pathname;

function clientRelease(): string | undefined {
  const name = basename(realpathSync(CLI_ROOT));
  return RELEASE_TAG.test(name) ? name : undefined;
}

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

function clientChecks(): Check[] {
  return [
    ...requiredTools("env").map((tool): Check => ({ name: tool, run: async () => (found(tool) ? ok() : fail(`${tool} is not installed`, installCommand(tool, process.platform))) })),
    {
      name: "gh login",
      run: async () => {
        if (!found("gh")) return skipped("gh is not installed");
        return spawnSync("gh", ["auth", "status"], { stdio: "ignore" }).status === 0 ? ok() : fail("gh is not logged in to github.com", "gh auth login");
      },
    },
    {
      name: "hosts file",
      run: async () => {
        try {
          loadHosts();
          return ok(existsSync(HOSTS_PATH) ? HOSTS_PATH : "no hosts file yet");
        } catch (error) {
          return fail(message(error), `fix ${HOSTS_PATH}, or move it away`);
        }
      },
    },
  ];
}

// The repo's Actions secrets need admin rights on the repo, which the App does not have: gh asks with the login of the user.
function actionsSecretCount(repo: Repo): number | undefined {
  if (!found("gh")) return undefined;
  const result = spawnSync("gh", ["api", `repos/${repo.owner}/${repo.name}/actions/secrets`, "--jq", ".total_count"], { encoding: "utf8" });
  const count = Number(result.stdout.trim());
  return result.status === 0 && Number.isInteger(count) ? count : undefined;
}

function connectionChecks(target: string, savedName: string | undefined, connection: { remote?: Connection; usable: boolean }): Check[] {
  return [
    {
      name: `ssh ${target}`,
      run: async () => {
        try {
          connection.remote = await reach(target);
          return ok(connection.remote.name);
        } catch (error) {
          return fail(message(error), `ssh ${target} true`);
        }
      },
    },
    {
      name: "sudo without a password",
      run: async () => {
        const { remote } = connection;
        if (!remote) return skipped("no SSH connection");
        if (remote.sudo === "") return ok("not needed");
        if ((await remote.shell.capture(`${remote.sudo}-n true`)).code !== 0) {
          return fail(`sudo on ${target} asks for a password: autopilot runs sudo over SSH with no terminal`, `on the host: echo "$USER ALL=(ALL) NOPASSWD:ALL" | sudo tee /etc/sudoers.d/90-autopilot`);
        }
        connection.usable = true;
        return ok();
      },
    },
    {
      name: "release",
      run: async () => {
        const { remote } = connection;
        if (!remote) return skipped("no SSH connection");
        const { code, stdout } = await remote.shell.capture(`readlink ${remote.layout.current}`);
        if (code !== 0) return fail("the host has no installed release", `autopilot hosts add ${savedName ?? "<name>"} ${target}`);
        return releaseVerdict(clientRelease(), releaseId(stdout.trim()), target);
      },
    },
  ];
}

async function hostSection(options: DoctorOptions, actionsSecrets: number | undefined): Promise<number> {
  const repoArgs = [...(options.repo ? ["--repo", `${options.repo.owner}/${options.repo.name}`] : []), ...(actionsSecrets === undefined ? [] : ["--actions-secrets", String(actionsSecrets)])];
  let ref: HostRef | undefined;
  try {
    ref = options.host();
  } catch (error) {
    return runDoctor([{ name: "host", run: async () => fail(message(error), "pass --host <name | ssh-target | local>, or fix the hosts file") }], console.log);
  }
  if (!ref) {
    if (existsSync(options.hostFile)) {
      console.log("\nHost (this machine)");
      return doctorHost(options.hostFile, options.repo, actionsSecrets);
    }
    return runDoctor([{ name: "host", run: async () => fail("no host is set, and this machine has no host file", "autopilot hosts add <name> <ssh-target | local>") }], console.log);
  }
  console.log(`\nHost ${ref.savedName ?? ref.target}`);
  const connection: { remote?: Connection; usable: boolean } = { usable: false };
  let failed = await runDoctor(connectionChecks(ref.target, ref.savedName, connection), console.log);
  if (!connection.usable) return failed;
  const code = await forward(ref.target, ["doctor-host", ...repoArgs]);
  if (code === 0) return failed;
  if (code === CHECKS_FAILED) return failed + 1;
  return failed + (await runDoctor([{ name: "doctor on the host", run: async () => fail(`the command on the host exited with ${code}`, `autopilot update --host ${ref.target}`) }], console.log));
}

function ghLabels(name: string): string[] {
  return execFileSync("gh", ["label", "list", "--repo", name, "--limit", "500", "--json", "name", "--jq", ".[].name"], { encoding: "utf8" }).split("\n");
}

function workflowJobs(dir: string): string[] {
  const folder = join(dir, ".github/workflows");
  if (!existsSync(folder)) return [];
  return readdirSync(folder)
    .filter((file) => /\.ya?ml$/.test(file))
    .flatMap((file) => workflowJobNames(readFileSync(join(folder, file), "utf8")));
}

async function repoSection(repo: Repo): Promise<number> {
  const name = `${repo.owner}/${repo.name}`;
  console.log(`\nRepo ${name}`);
  const work = mkdtempSync(join(tmpdir(), "autopilot-doctor-"));
  const state: { dir?: string; config?: Config } = {};
  const withDir = (run: (dir: string) => Promise<Verdict>) => async (): Promise<Verdict> => (state.dir ? run(state.dir) : skipped("the clone failed"));
  const withConfig = (run: (config: Config, dir: string) => Promise<Verdict>) => async (): Promise<Verdict> => (state.dir && state.config ? run(state.config, state.dir) : skipped("the config is missing or not valid"));
  const checks: Check[] = [
    {
      name: `clone ${name}`,
      run: async () => {
        const dir = join(work, "repo");
        try {
          execFileSync("gh", ["repo", "clone", name, dir, "--", "--depth", "1", "--quiet"], { stdio: ["ignore", "ignore", "pipe"] });
        } catch (error) {
          return fail(`gh cannot clone ${name}: ${message(error)}`, `gh repo view ${name}`);
        }
        state.dir = dir;
        return ok();
      },
    },
    {
      name: CONFIG_PATH,
      run: withDir(async (dir) => {
        const path = join(dir, CONFIG_PATH);
        if (!existsSync(path)) return fail(`${name} has no ${CONFIG_PATH}`, `autopilot init --repo ${name}`);
        try {
          state.config = parseConfig(readFileSync(path, "utf8"), CONFIG_PATH);
          return ok(`verify.mode ${state.config.verify.mode}`);
        } catch (error) {
          return fail(message(error), `edit ${CONFIG_PATH} to match schema/autopilot.schema.json, then commit it`);
        }
      }),
    },
    { name: "labels", run: async () => labelsVerdict(ghLabels(name), name) },
    {
      name: ".devcontainer",
      run: withDir(async (dir) => {
        if (!existsSync(join(dir, ".devcontainer")) && !existsSync(join(dir, ".devcontainer.json"))) return fail(`${name} has no .devcontainer/`, `autopilot init --repo ${name}`);
        try {
          const { problems } = await inspectEnvironment(cliDevcontainer, realpathSync(dir), "autopilot-doctor");
          return problems.length === 0 ? ok() : fail(problems.map((problem) => `- ${problem}`).join("\n"), "change .devcontainer/ so that it passes the guardrails above, then commit it");
        } catch (error) {
          if (!(error instanceof EnvironmentRefused)) throw error;
          return fail(error.problems.map((problem) => `- ${problem}`).join("\n"), "change .devcontainer/ so that it passes the guardrails above, then commit it");
        }
      }),
    },
    { name: "check commands", run: withConfig(async (config) => checkCommandsVerdict(config)) },
    { name: "CI jobs", run: withConfig(async (config, dir) => ciJobsVerdict(config, workflowJobs(dir))) },
  ];
  try {
    return await runDoctor(checks, console.log);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

export async function doctor(options: DoctorOptions): Promise<number> {
  const { repo } = options;
  console.log("Client");
  let failed = await runDoctor(clientChecks(), console.log);
  failed += await hostSection(options, repo && actionsSecretCount(repo));
  if (repo) failed += await repoSection(repo);
  else for (const line of formatResult("repo", skipped("this folder is not a checkout of a GitHub repo: run doctor in one, or pass --repo <owner>/<repo>"))) console.log(line);
  console.log(failed === 0 ? "\nNo problem found." : `\n${failed} check${failed === 1 ? "" : "s"} failed.`);
  return failed === 0 ? 0 : 1;
}
