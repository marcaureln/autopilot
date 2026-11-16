import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { cancel, confirm, type CANCEL_SYMBOL, intro, isCancel, log, note, outro, password, select, text } from "@clack/prompts";
import { ALLOW_ENTRY } from "../core/allow.ts";
import type { Audit } from "../core/audit.ts";
import { CONFIG_PATH } from "../core/config.ts";
import { createGitHub } from "../core/github.ts";
import { parseHost, type Host } from "../core/host.ts";
import { ownPull, type PullListing } from "../core/onboarding.ts";
import { SECRETS_VAULT } from "../core/repo-secrets.ts";
import { readSecret } from "../core/secrets.ts";
import { checkResources, describeResources, installCommand, isRepoEntry, parseList, parseResources, parseSetupConfig, planHostSetup, RESOURCES_PROBE, TOOLS, type HostFacts, type SetupConfig } from "../core/setup.ts";
import { alias, aliasFile, shellOf, withoutAlias } from "./alias.ts";
import { appCreate, appKeyStored, githubLogin } from "./app.ts";
import { APP_KEY_FILE, APP_KEY_ITEM, CLAUDE_TOKEN_ITEM, forward, HOST_SECRETS, hostSetup, OP_TOKEN_ITEM } from "./client.ts";
import { connect, SERVICE, type Connection } from "./host.ts";
import { BRANCH as ONBOARDING_BRANCH, init } from "./init.ts";
import { op } from "./secrets.ts";

export type SetupOptions = { configFile?: string; yes: boolean; host?: string; version?: string; fromCheckout: boolean };

type Cancel = typeof CANCEL_SYMBOL;

type Outcome = "already done" | "done" | "skipped";

type HostState = { host?: Host; opToken: boolean; release?: string; service: string };

const noAudit: Audit = () => {};

const results: { step: string; outcome: Outcome; detail: string }[] = [];

function record(step: string, outcome: Outcome, detail: string): void {
  results.push({ step, outcome, detail });
  const line = `${step}: ${outcome} (${detail})`;
  if (outcome === "skipped") log.info(line);
  else log.success(line);
}

async function answer<T>(prompt: Promise<T | Cancel>): Promise<T> {
  const value = await prompt;
  if (isCancel(value)) {
    cancel("Setup stopped. Run autopilot setup again to continue: it keeps what is done.");
    process.exit(1);
  }
  return value;
}

function configOrAsk<T>(options: SetupOptions, value: T | undefined, field: string, prompt: () => Promise<T | Cancel>): Promise<T> {
  if (value !== undefined) return Promise.resolve(value);
  if (options.yes) throw new Error(`--yes: set "${field}" in the setup file`);
  return answer(prompt());
}

function found(tool: string): boolean {
  return spawnSync("sh", ["-c", `command -v ${tool}`], { stdio: "ignore" }).status === 0;
}

function prerequisites(): void {
  const missing = TOOLS.filter((tool) => !found(tool));
  if (missing.length === 0) return record("Prerequisites", "already done", TOOLS.join(", "));
  for (const tool of missing) log.error(`${tool} is missing. Install it: ${installCommand(tool, process.platform)}`);
  throw new Error(`install ${missing.join(", ")}, then run autopilot setup again`);
}

function githubSignIn(options: SetupOptions): string {
  const signedIn = githubLogin();
  if (signedIn) {
    record("GitHub sign-in", "already done", `gh as ${signedIn}`);
    return signedIn;
  }
  if (options.yes) throw new Error("--yes: gh is not signed in. Run gh auth login first");
  spawnSync("gh", ["auth", "login", "--hostname", "github.com", "--git-protocol", "https", "--web"], { stdio: "inherit" });
  const login = githubLogin();
  if (!login) throw new Error("gh is still not signed in");
  record("GitHub sign-in", "done", `gh as ${login}`);
  return login;
}

function opItemExists(title: string): boolean {
  return op(["item", "get", title, "--vault", SECRETS_VAULT, "--format", "json"]).ok;
}

async function onePassword(options: SetupOptions): Promise<void> {
  let vault = op(["vault", "get", SECRETS_VAULT, "--format", "json"]);
  if (!vault.ok && /not signed in|no accounts/i.test(vault.stderr)) {
    if (options.yes) throw new Error(`--yes: op is not signed in: ${vault.stderr}`);
    spawnSync("op", ["signin"], { stdio: "inherit" });
    vault = op(["vault", "get", SECRETS_VAULT, "--format", "json"]);
  }
  if (vault.ok) record("1Password vault", "already done", SECRETS_VAULT);
  else if (/isn't a vault/i.test(vault.stderr)) {
    const create = options.yes || (await answer(confirm({ message: `Create the 1Password vault ${SECRETS_VAULT}? Autopilot keeps its secrets there.` })));
    if (!create) throw new Error(`autopilot needs the vault ${SECRETS_VAULT}`);
    const created = op(["vault", "create", SECRETS_VAULT]);
    if (!created.ok) throw new Error(`op could not create the vault ${SECRETS_VAULT}: ${created.stderr}`);
    record("1Password vault", "done", `created ${SECRETS_VAULT}`);
  } else throw new Error(`op cannot open the vault ${SECRETS_VAULT}: ${vault.stderr}`);

  if (opItemExists(OP_TOKEN_ITEM)) return record("1Password service account", "already done", `token in ${SECRETS_VAULT}/${OP_TOKEN_ITEM}`);
  const account = op(["service-account", "create", "autopilot", "--vault", `${SECRETS_VAULT}:read_items`, "--raw"]);
  if (!account.ok) throw new Error(`op could not create the service account: ${account.stderr}`);
  const item = { title: OP_TOKEN_ITEM, category: "PASSWORD", fields: [{ id: "password", type: "CONCEALED", purpose: "PASSWORD", label: "password", value: account.stdout.trim() }] };
  const saved = op(["item", "create", "--vault", SECRETS_VAULT, "--format", "json", "-"], JSON.stringify(item));
  if (!saved.ok) throw new Error(`op could not save the service account token: ${saved.stderr}`);
  record("1Password service account", "done", `created, token in ${SECRETS_VAULT}/${OP_TOKEN_ITEM}`);
}

async function githubApp(options: SetupOptions, config: SetupConfig): Promise<number> {
  const keyStored = appKeyStored();
  const choice =
    config.app_id !== undefined
      ? "reuse"
      : await configOrAsk(options, undefined, "app_id", () =>
          select({
            message: "GitHub App",
            initialValue: keyStored ? "reuse" : "create",
            options: [
              { value: "create", label: "Create a new App", hint: "in the browser, one click" },
              { value: "reuse", label: "Use an App I already have", hint: "its private key goes to 1Password" },
            ],
          }),
        );
  if (choice === "create") {
    const app = await appCreate({});
    record("GitHub App", "done", `created ${app.slug} (id ${app.id}). Install it: ${app.installUrl}`);
    return app.id;
  }

  const appId = await configOrAsk(options, config.app_id, "app_id", async () => {
    const value = await text({ message: "App ID (on the App's settings page)", validate: (input) => (/^[1-9]\d*$/.test(input ?? "") ? undefined : "A number") });
    return isCancel(value) ? value : Number(value);
  });
  if (!keyStored) {
    if (options.yes) throw new Error(`--yes: the private key of App ${appId} is not in 1Password. Save it as the document ${APP_KEY_ITEM} (file name ${APP_KEY_FILE}) in the vault ${SECRETS_VAULT}`);
    const path = await answer(text({ message: "Path of the App's private key file (.pem)", validate: (input) => (existsSync(input ?? "") ? undefined : "No file at this path") }));
    const saved = op(["document", "create", path, "--vault", SECRETS_VAULT, "--title", APP_KEY_ITEM, "--file-name", APP_KEY_FILE]);
    if (!saved.ok) throw new Error(`op could not save the private key: ${saved.stderr}`);
  }
  const privateKey = readSecret(HOST_SECRETS.app_key, "setup: check the App key", noAudit);
  const slug = await createGitHub({ appId, privateKey }, noAudit)
    .appSlug()
    .catch((error: unknown) => {
      throw new Error(`the key in 1Password does not open App ${appId}: ${error instanceof Error ? error.message : String(error)}`);
    });
  record("GitHub App", keyStored ? "already done" : "done", `${slug} (id ${appId}), key in 1Password`);
  return appId;
}

async function claudeToken(options: SetupOptions): Promise<void> {
  if (opItemExists(CLAUDE_TOKEN_ITEM)) return record("Claude token", "already done", `in ${SECRETS_VAULT}/${CLAUDE_TOKEN_ITEM}`);
  let token = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  if (!token) {
    if (options.yes) throw new Error("--yes: no Claude token in 1Password. Run claude setup-token and pass its token in CLAUDE_CODE_OAUTH_TOKEN");
    if (found("claude") && (await answer(confirm({ message: "Run claude setup-token now? It signs in to Claude in the browser and prints a token." })))) {
      spawnSync("claude", ["setup-token"], { stdio: "inherit" });
    }
    token = await answer(password({ message: "Paste the Claude token (hidden)", validate: (input) => (input?.trim() ? undefined : "The token is empty") }));
  }
  const item = { title: CLAUDE_TOKEN_ITEM, category: "API_CREDENTIAL", fields: [{ id: "credential", type: "CONCEALED", label: "credential", value: token.trim() }] };
  const saved = op(["item", "create", "--vault", SECRETS_VAULT, "--format", "json", "-"], JSON.stringify(item));
  if (!saved.ok) throw new Error(`op could not save the Claude token: ${saved.stderr}`);
  record("Claude token", "done", `saved in ${SECRETS_VAULT}/${CLAUDE_TOKEN_ITEM}`);
}

async function chooseHost(options: SetupOptions, config: SetupConfig): Promise<{ target: string; remote: Connection }> {
  const target = await configOrAsk(options, config.host ?? options.host, "host", () =>
    text({
      message: "Host: an SSH target such as user@my-host, or local for this machine",
      initialValue: "local",
      validate: (input) => (/^[^-\s]\S*$/.test(input ?? "") ? undefined : "An SSH target or local"),
    }),
  );
  const remote = await connect(target);
  const probe = await remote.shell.capture(RESOURCES_PROBE);
  if (probe.code !== 0) throw new Error(`cannot read the resources of ${target} (exit ${probe.code})`);
  const resources = parseResources(probe.stdout);
  const check = checkResources(resources);
  for (const warning of check.warnings) log.warn(warning);
  if (check.errors.length > 0) throw new Error(check.errors.join("; "));
  record("Host", "already done", `${target}: ${remote.layout.os}, ${describeResources(resources)}`);
  return { target, remote };
}

async function hostState(remote: Connection): Promise<HostState> {
  const { layout, shell, sudo } = remote;
  const hostFile = await shell.capture(`cat ${layout.hostFile} 2>/dev/null`);
  const opToken = await shell.capture(`${sudo}test -s ${layout.opToken}`);
  const release = await shell.capture(`readlink ${layout.current}`);
  const service = await shell.capture(
    layout.os === "linux" ? `systemctl is-active ${SERVICE}` : `launchctl print gui/$(id -u)/${SERVICE} 2>/dev/null | awk '$1 == "state" { print $3; exit }'`,
  );
  return {
    host: hostFile.code === 0 ? parseHost(hostFile.stdout, layout.hostFile) : undefined,
    opToken: opToken.code === 0,
    release: release.code === 0 ? release.stdout.trim() : undefined,
    service: service.stdout.trim() || "not loaded",
  };
}

function factsOf(state: HostState): HostFacts {
  return { hasHost: state.host !== undefined, opToken: state.opToken, release: state.release, service: state.service };
}

async function setUpHost(options: SetupOptions, config: SetupConfig, target: string, remote: Connection, appId: number, login: string): Promise<Host> {
  let state = await hostState(remote);
  const plan = planHostSetup(factsOf(state), options);
  if (plan.kind === "refuse") throw new Error(`${target}: ${plan.reason}`);
  if (plan.kind === "ready") {
    record("Host setup", "already done", `${state.release}, service ${state.service}`);
  } else {
    if (plan.problem) {
      if (options.yes) throw new Error(`${target}: ${plan.problem}. With --yes, setup does not reinstall or restart a host. Fix it, or run autopilot setup without --yes`);
      const again = await answer(confirm({ message: `${plan.problem}. Install ${plan.version ?? "this checkout"} again, push the 1Password token and restart the service?` }));
      if (!again) throw new Error(`${target}: ${plan.problem}`);
    }
    const owner = state.host
      ? undefined
      : await configOrAsk(options, config.owner ?? (options.yes ? login : undefined), "owner", () =>
          text({ message: "GitHub login that may start jobs (the owner)", initialValue: login, validate: (input) => (/^[A-Za-z0-9-]+$/.test(input ?? "") ? undefined : "A GitHub login") }),
        );
    await hostSetup(target, { owner, appId, version: plan.version, fromCheckout: plan.fromCheckout });
    state = await hostState(remote);
    const after = planHostSetup(factsOf(state), options);
    if (after.kind !== "ready") throw new Error(`host setup ran, but the host is not ready: service ${state.service}`);
    record("Host setup", "done", `${state.release}, service ${state.service}`);
  }
  const host = state.host;
  if (!host) throw new Error("the host has no host.json");
  if (host.app_id !== appId) log.warn(`host.json on ${target} uses App ${host.app_id}, not ${appId}. Setup does not change it: edit ${remote.layout.hostFile} if this is wrong.`);
  if (!host.owners.includes(login)) log.warn(`${login} is not in the owners of ${target} (${host.owners.join(", ")}). Edit ${remote.layout.hostFile} to add it.`);
  return host;
}

async function allowEntries(options: SetupOptions, config: SetupConfig, target: string, host: Host, login: string): Promise<void> {
  const entries =
    config.allow ??
    (options.yes
      ? []
      : parseList(
          await answer(
            text({
              message: "Accounts, orgs or owner/repo entries that autopilot may work on (comma-separated, empty for none)",
              initialValue: host.allow.join(", "),
              placeholder: login,
              validate: (input) => (parseList(input ?? "").every((entry) => ALLOW_ENTRY.test(entry)) ? undefined : "Use owner or owner/repo entries"),
            }),
          ),
        ));
  if (entries.length === 0) return record("Allowlist", "skipped", "no entry to add");
  for (const entry of entries) {
    if (host.allow.includes(entry)) {
      record(`Allow ${entry}`, "already done", `on ${host.name}`);
      continue;
    }
    if ((await forward(target, ["allow", entry])) !== 0) throw new Error(`the host could not allow ${entry}`);
    record(`Allow ${entry}`, "done", `on ${host.name}`);
  }
}

function onboarded(repo: string): boolean {
  return spawnSync("gh", ["api", `repos/${repo}/contents/${CONFIG_PATH}`, "--silent"], { stdio: "ignore" }).status === 0;
}

// init rewrites the branch and the pull request body on every run, so an open pull request means the repo waits for a merge.
function onboardingPullOpen(repo: string, owner: string, name: string): boolean {
  const listing = spawnSync("gh", ["pr", "list", "--repo", repo, "--head", ONBOARDING_BRANCH, "--state", "open", "--json", "url,isCrossRepository,headRepositoryOwner,headRepository"], { encoding: "utf8" });
  if (listing.status !== 0) throw new Error(`gh could not list the pull requests of ${repo}: ${listing.stderr.trim()}`);
  const pulls: PullListing[] = JSON.parse(listing.stdout);
  return ownPull(pulls, { owner, name }) !== undefined;
}

async function chooseRepos(login: string): Promise<string[]> {
  if (!(await answer(confirm({ message: "Onboard a repo now? autopilot init opens a pull request on it." })))) return [];
  const listing = spawnSync("gh", ["repo", "list", login, "--limit", "100", "--no-archived", "--json", "nameWithOwner", "--jq", ".[].nameWithOwner"], { encoding: "utf8" });
  const repos = listing.status === 0 ? listing.stdout.split("\n").filter(Boolean) : [];
  if (repos.length === 0) {
    const entry = await answer(text({ message: "Repo to onboard (owner/repo)", validate: (input) => (isRepoEntry(input ?? "") ? undefined : "Use owner/repo") }));
    return [entry];
  }
  return [await answer(select({ message: "Repo to onboard", options: repos.map((repo) => ({ value: repo, label: repo })) }))];
}

async function onboard(options: SetupOptions, config: SetupConfig, target: string, login: string): Promise<void> {
  const repos = config.init ?? (options.yes ? [] : await chooseRepos(login));
  if (repos.length === 0) return record("First repo", "skipped", "no repo to onboard");
  const invalid = repos.filter((repo) => !isRepoEntry(repo));
  if (invalid.length > 0) throw new Error(`not a repo as owner/repo: ${invalid.join(", ")}`);
  for (const repo of repos) {
    if (onboarded(repo)) {
      record(`Onboard ${repo}`, "already done", `${CONFIG_PATH} exists`);
      continue;
    }
    const [owner = "", name = ""] = repo.split("/");
    if (onboardingPullOpen(repo, owner, name)) {
      record(`Onboard ${repo}`, "already done", "onboarding PR open");
      continue;
    }
    await init({ repo: { owner, name }, host: target, agent: true });
    record(`Onboard ${repo}`, "done", "merge the onboarding pull request");
  }
}

async function shellAlias(options: SetupOptions, config: SetupConfig): Promise<void> {
  let file: string;
  try {
    file = aliasFile(shellOf(process.env.SHELL), process.platform, homedir());
  } catch (error) {
    return record("Alias", "skipped", error instanceof Error ? error.message : String(error));
  }
  const current = existsSync(file) ? readFileSync(file, "utf8") : "";
  if (withoutAlias(current) !== current) return record("Alias", "already done", `in ${file}`);
  const name = config.alias ?? (options.yes ? false : (await answer(text({ message: "Short name for autopilot in your shell (empty for none)", initialValue: "ap" }))) || false);
  if (name === false) return record("Alias", "skipped", "no alias wanted");
  alias(name, false);
  record("Alias", "done", `${name} in ${file}`);
}

export async function setup(options: SetupOptions): Promise<void> {
  if (options.yes && !options.configFile) throw new Error("--yes needs --config <setup file>");
  const config = options.configFile ? parseSetupConfig(readFileSync(options.configFile, "utf8"), options.configFile) : {};
  intro("autopilot setup");
  log.info("Each step checks what is in place and only does what is missing.");
  prerequisites();
  const login = githubSignIn(options);
  await onePassword(options);
  const appId = await githubApp(options, config);
  await claudeToken(options);
  const { target, remote } = await chooseHost(options, config);
  const host = await setUpHost(options, config, target, remote, appId, login);
  await allowEntries(options, config, target, host, login);
  await onboard(options, config, target, login);
  await shellAlias(options, config);
  note(results.map(({ step, outcome }) => `${outcome.padEnd(12)}  ${step}`).join("\n"), "Summary");
  log.step(`autopilot status on ${target}`);
  if ((await forward(target, ["status"])) !== 0) throw new Error(`autopilot status failed on ${target}`);
  outro(`Done. Manage this host with: export AUTOPILOT_HOST=${target}`);
}
