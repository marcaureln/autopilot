import { execFile, execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { confirm, isCancel, log, password, text } from "@clack/prompts";
import type { Audit } from "../core/audit.ts";
import { CONFIG_DIR } from "../core/config-dir.ts";
import { createGitHub } from "../core/github.ts";
import { hostSecretFiles, parseHost, SECRET_LABELS, type Host, type HostSecret, type HostSecretFile } from "../core/host.ts";
import { LOCAL_TARGET, RUN_HERE } from "../core/hosts.ts";
import { SECRETS_VAULT } from "../core/repo-secrets.ts";
import { readSecret, type Backend } from "../core/secrets.ts";
import { connect, installRelease, latestRelease, must, parseTag, SERVICE, type Release, type Connection } from "./host.ts";

const CLI_ROOT = new URL("../../", import.meta.url).pathname;
const HOST_SCHEMA = "https://raw.githubusercontent.com/marcaureln/autopilot/main/schema/host.schema.json";
export const APP_KEY_ITEM = "github-app-private-key";
export const APP_KEY_FILE = "app.pem";
export const CLAUDE_TOKEN_ITEM = "claude-token";
export const OP_TOKEN_ITEM = "op-service-account-token";
const OP_TOKEN_REFERENCE = `op://${SECRETS_VAULT}/${OP_TOKEN_ITEM}/password`;
export const HOST_SECRETS: Record<Backend, Host["secrets"]> = {
  env: { app_key: "file:app-key.pem", claude_token: "file:claude-token" },
  op: { app_key: `op://${SECRETS_VAULT}/${APP_KEY_ITEM}/${APP_KEY_FILE}`, claude_token: `op://${SECRETS_VAULT}/${CLAUDE_TOKEN_ITEM}/credential` },
};
export const APP_KEY_PATH = join(CONFIG_DIR, "app-key.pem");

export function shellQuote(arg: string): string {
  return `'${arg.replaceAll("'", `'\\''`)}'`;
}

// Forwarded output can carry text from GitHub or from agents, so the client opens only the page that `watch` prints.
export function urlToOpen(command: string, line: string): string | undefined {
  if (command !== "watch") return undefined;
  return /^open: (https:\/\/github\.com\/apps\/[a-z0-9-]+\/installations\/new\/permissions\?target_id=\d+)$/.exec(line)?.[1];
}

export function openInBrowser(url: string): void {
  execFile(process.platform === "darwin" ? "open" : "xdg-open", [url], () => {});
}

// The client does not know the OS of the host. Host setup puts the command in these places.
export function hostCommand(args: string[]): string {
  const quoted = [`--host=${RUN_HERE}`, ...args].map(shellQuote).join(" ");
  return `case $(uname -s) in Darwin) exec "$HOME/.autopilot/bin/autopilot" ${quoted} ;; *) exec sudo autopilot ${quoted} ;; esac`;
}

// `input` goes to the host command on stdin, so a secret value never becomes an argument.
export function forward(target: string, args: string[], input?: string): Promise<number> {
  const [program, through]: [string, string[]] = target === LOCAL_TARGET ? ["sh", ["-c"]] : ["ssh", [target]];
  const command = [...through, hostCommand(args)];
  const child = input === undefined ? spawn(program, command, { stdio: ["inherit", "pipe", "inherit"] }) : spawn(program, command, { stdio: ["pipe", "pipe", "inherit"] });
  // If the host command exits before it reads stdin, the exit code reports it: the EPIPE adds nothing.
  child.stdin?.on("error", () => undefined);
  if (input !== undefined) child.stdin?.end(input);
  createInterface({ input: child.stdout }).on("line", (line) => {
    console.log(line);
    const url = urlToOpen(args[0] ?? "", line);
    if (url) openInBrowser(url);
  });
  return new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => resolve(code ?? 1));
  });
}

function writeHostFile(remote: Connection, path: string, mode: "600" | "644"): string {
  return `${remote.sudo}sh -c 'set -e; install -d -m 755 ${dirname(path)}; umask 077; cat > ${path}.tmp; chmod ${mode} ${path}.tmp; mv ${path}.tmp ${path}'`;
}

export function found(tool: string): boolean {
  return spawnSync("sh", ["-c", `command -v ${tool}`], { stdio: "ignore" }).status === 0;
}

const noAudit: Audit = () => {};

export async function checkAppKey(appId: number, privateKey: string, where: string): Promise<string> {
  return createGitHub({ appId, privateKey }, noAudit)
    .appSlug()
    .catch((error: unknown) => {
      throw new Error(`the key in ${where} does not open App ${appId}: ${error instanceof Error ? error.message : String(error)}`);
    });
}

export function readKeyFile(path: string): string {
  if (!existsSync(path)) throw new Error(`no App key file at ${path}`);
  return readFileSync(path, "utf8");
}

export async function readAppKey(path: string | undefined, interactive: boolean): Promise<string> {
  let file = path ?? (existsSync(APP_KEY_PATH) ? APP_KEY_PATH : undefined);
  if (!file) {
    if (!interactive) throw new Error(`no GitHub App key: pass --app-key <pem file> (the app_key field of the setup file) with the private key of the App, or create the App with autopilot app create`);
    const answer = await text({ message: "Path of the App's private key file (.pem)", validate: (input) => (existsSync(input ?? "") ? undefined : "No file at this path") });
    if (isCancel(answer)) throw new Error("cancelled");
    file = answer;
  }
  return readKeyFile(file);
}

export async function readClaudeToken(interactive: boolean): Promise<string> {
  const fromEnv = process.env.CLAUDE_CODE_OAUTH_TOKEN?.trim();
  if (fromEnv) return fromEnv;
  if (!interactive) throw new Error("no Claude token: run claude setup-token on any machine with Claude Code, and pass its token in CLAUDE_CODE_OAUTH_TOKEN");
  const run = found("claude") && (await confirm({ message: "Run claude setup-token now? It signs in to Claude in the browser and prints a token." }));
  if (isCancel(run)) throw new Error("cancelled");
  if (run) spawnSync("claude", ["setup-token"], { stdio: "inherit" });
  else log.info("Run claude setup-token on any machine with Claude Code. It signs in to Claude in the browser and prints a token.");
  const token = await password({ message: "Paste the Claude token (hidden)", validate: (input) => (input?.trim() ? undefined : "The token is empty") });
  if (isCancel(token)) throw new Error("cancelled");
  return token.trim();
}

export async function clientClaudeToken(backend: Backend, interactive: boolean): Promise<string> {
  return backend === "op" ? readSecret(HOST_SECRETS.op.claude_token, "init: token for the onboarding agent", noAudit) : readClaudeToken(interactive);
}

export type SecretSources = Record<Exclude<HostSecret, "op_token">, () => Promise<string>>;

// The service user reads the host secrets through the group of the secrets folder, as it reads the repo files.
export function writeSecretFile(remote: Pick<Connection, "layout" | "sudo">, path: string): string {
  const access = remote.layout.os === "linux" ? `chgrp autopilot ${path}.tmp; chmod 640` : "chmod 600";
  return `${remote.sudo}sh -c 'set -e; umask 077; cat > ${path}.tmp; ${access} ${path}.tmp; mv ${path}.tmp ${path}'`;
}

export async function missingSecrets(remote: Connection, files: HostSecretFile[]): Promise<HostSecretFile[]> {
  const missing: HostSecretFile[] = [];
  for (const file of files) {
    if ((await remote.shell.capture(`${remote.sudo}test -s ${file.path}`)).code !== 0) missing.push(file);
  }
  return missing;
}

function initialHostFile({ name, owner, appId, backend }: { name: string; owner: string; appId: number; backend: Backend }): Host {
  return {
    $schema: HOST_SCHEMA,
    name,
    app_id: appId,
    secrets: HOST_SECRETS[backend],
    owners: [owner],
    allow: [],
    docker: "rootless",
    poll_interval_seconds: 60,
    concurrency: 1,
    limits: { memory: "6g", cpus: 2, pids: 1024 },
  };
}

function checkoutRelease(): Release {
  if (execFileSync("git", ["status", "--porcelain"], { cwd: CLI_ROOT, encoding: "utf8" }).trim()) {
    console.warn("warning: uncommitted changes are not deployed, only HEAD is");
  }
  return {
    kind: "checkout",
    commit: execFileSync("git", ["rev-parse", "--short=12", "HEAD"], { cwd: CLI_ROOT, encoding: "utf8" }).trim(),
    archive: () => execFileSync("git", ["archive", "--format=tar", "HEAD"], { cwd: CLI_ROOT, maxBuffer: 256 * 1024 * 1024 }),
  };
}

async function hostFile(remote: Connection, options: { owner?: string; appId?: number; backend: Backend }): Promise<Host> {
  const path = remote.layout.hostFile;
  const { code, stdout } = await remote.shell.capture(`${remote.sudo}cat ${path} 2>/dev/null`);
  if (code === 0) return parseHost(stdout, path);
  if (!options.owner || !options.appId) throw new Error("the host has no host.json yet: pass --owner <login> --app-id <id>");
  const text = JSON.stringify(initialHostFile({ name: remote.name, owner: options.owner, appId: options.appId, backend: options.backend }), null, 2) + "\n";
  const host = parseHost(text, "the new host.json");
  console.log(`==> host.json (new, host name ${host.name})`);
  await must(remote.shell, "host.json", writeHostFile(remote, path, "644"), Buffer.from(text));
  return host;
}

export type HostSetupOptions = { owner?: string; appId?: number; version?: string; fromCheckout: boolean; backend: Backend; sources: SecretSources };

export async function hostSetup(target: string, options: HostSetupOptions): Promise<HostSecret[]> {
  const release: Release = options.fromCheckout ? checkoutRelease() : { kind: "github", tag: options.version ? parseTag(options.version) : await latestRelease() };
  const remote = await connect(target);
  const host = await hostFile(remote, options);
  const files = hostSecretFiles(host.secrets, remote.layout);
  const missing = await missingSecrets(remote, files);
  for (const file of files) if (!missing.includes(file)) console.log(`==> ${SECRET_LABELS[file.secret]}: already on the host`);

  // The values come before the install, so the questions do not wait for it.
  const values: { file: HostSecretFile; value: string }[] = [];
  for (const file of missing) {
    if (file.secret === "op_token") continue;
    const value = await options.sources[file.secret]();
    if (file.secret === "app_key") await checkAppKey(host.app_id, value, "the App key file");
    values.push({ file, value });
  }

  // setup.sh installs op and loads this token into the service only when the file exists.
  if (missing.some((file) => file.secret === "op_token")) {
    console.log(`==> ${SECRET_LABELS.op_token}`);
    const token = execFileSync("op", ["read", "--no-newline", OP_TOKEN_REFERENCE], { stdio: ["ignore", "pipe", "inherit"] });
    await must(remote.shell, "op token", writeHostFile(remote, remote.layout.opToken, "600"), token);
  }

  await installRelease(remote, release, host.docker);

  // setup.sh makes the secrets folder and its group, so the files come after it.
  for (const { file, value } of values) {
    console.log(`==> ${SECRET_LABELS[file.secret]}`);
    await must(remote.shell, SECRET_LABELS[file.secret], writeSecretFile(remote, file.path), Buffer.from(value));
  }
  if (values.length > 0) {
    // The service read its secrets when setup.sh started it, before these files existed.
    const restart = remote.layout.os === "linux" ? `${remote.sudo}systemctl restart ${SERVICE}` : `launchctl kickstart -k gui/$(id -u)/${SERVICE}`;
    await must(remote.shell, "restart", restart);
  }
  return missing.map((file) => file.secret);
}

export async function selfUpdate(version: string | undefined): Promise<void> {
  if (existsSync(join(CLI_ROOT, ".git"))) throw new Error(`autopilot runs from the checkout ${CLI_ROOT}: update it with git pull`);
  const tag = version ? parseTag(version) : await latestRelease();
  const result = spawnSync("sh", [join(CLI_ROOT, "install.sh"), tag], { stdio: "inherit" });
  if (result.status !== 0) throw new Error(`install.sh ${tag} failed (exit ${result.status})`);
}
