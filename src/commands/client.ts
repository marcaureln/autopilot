import { execFile, execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { parseHost, type Host } from "../core/host.ts";
import { SECRETS_VAULT } from "../core/repo-secrets.ts";
import { connect, installRelease, latestRelease, LOCAL_TARGET, must, parseTag, type Release, type Connection } from "./host.ts";

const CLI_ROOT = new URL("../../", import.meta.url).pathname;
const HOST_SCHEMA = "https://raw.githubusercontent.com/marcaureln/autopilot/main/schema/host.schema.json";
export const APP_KEY_ITEM = "github-app-private-key";
export const APP_KEY_FILE = "app.pem";
export const CLAUDE_TOKEN_ITEM = "claude-token";
export const OP_TOKEN_ITEM = "op-service-account-token";
const OP_TOKEN_REFERENCE = `op://${SECRETS_VAULT}/${OP_TOKEN_ITEM}/password`;
export const HOST_SECRETS: Host["secrets"] = {
  app_key: `op://${SECRETS_VAULT}/${APP_KEY_ITEM}/${APP_KEY_FILE}`,
  claude_token: `op://${SECRETS_VAULT}/${CLAUDE_TOKEN_ITEM}/credential`,
};

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
  const quoted = args.map(shellQuote).join(" ");
  return `case $(uname -s) in Darwin) exec "$HOME/.autopilot/bin/autopilot" ${quoted} ;; *) exec sudo autopilot ${quoted} ;; esac`;
}

// `input` goes to the host command on stdin, so a secret value never becomes an argument.
export function forward(target: string, args: string[], input?: string): Promise<number> {
  // On the local host, the host command would read AUTOPILOT_HOST=local and forward to itself again.
  const env = { ...process.env, AUTOPILOT_HOST: undefined };
  const [program, through]: [string, string[]] = target === LOCAL_TARGET ? ["sh", ["-c"]] : ["ssh", [target]];
  const command = [...through, hostCommand(args)];
  const child = input === undefined ? spawn(program, command, { stdio: ["inherit", "pipe", "inherit"], env }) : spawn(program, command, { stdio: ["pipe", "pipe", "inherit"], env });
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

export function initialHostFile({ name, owner, appId }: { name: string; owner: string; appId: number }): Host {
  return {
    $schema: HOST_SCHEMA,
    name,
    app_id: appId,
    secrets: HOST_SECRETS,
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

async function hostFile(remote: Connection, options: { owner?: string; appId?: number }): Promise<Host> {
  const path = remote.layout.hostFile;
  const { code, stdout } = await remote.shell.capture(`${remote.sudo}cat ${path} 2>/dev/null`);
  if (code === 0) return parseHost(stdout, path);
  if (!options.owner || !options.appId) throw new Error("the host has no host.json yet: pass --owner <login> --app-id <id>");
  const text = JSON.stringify(initialHostFile({ name: remote.name, owner: options.owner, appId: options.appId }), null, 2) + "\n";
  const host = parseHost(text, "the new host.json");
  console.log(`==> host.json (new, host name ${host.name})`);
  await must(remote.shell, "host.json", writeHostFile(remote, path, "644"), Buffer.from(text));
  return host;
}

export async function hostSetup(target: string, options: { owner?: string; appId?: number; version?: string; fromCheckout: boolean }): Promise<void> {
  const release: Release = options.fromCheckout ? checkoutRelease() : { kind: "github", tag: options.version ? parseTag(options.version) : await latestRelease() };
  const remote = await connect(target);

  // Each read asks to unlock 1Password on the laptop, so an update keeps the token the host has.
  // To change it, remove the file on the host and run setup again.
  const present = await remote.shell.capture(`${remote.sudo}test -s ${remote.layout.opToken}`);
  if (present.code === 0) console.log("==> 1Password service account token: already on the host");
  else {
    console.log("==> 1Password service account token");
    const token = execFileSync("op", ["read", "--no-newline", OP_TOKEN_REFERENCE], { stdio: ["ignore", "pipe", "inherit"] });
    await must(remote.shell, "op token", writeHostFile(remote, remote.layout.opToken, "600"), token);
  }

  const host = await hostFile(remote, options);
  await installRelease(remote, release, host.docker);
}

export async function selfUpdate(version: string | undefined): Promise<void> {
  if (existsSync(join(CLI_ROOT, ".git"))) throw new Error(`autopilot runs from the checkout ${CLI_ROOT}: update it with git pull`);
  const tag = version ? parseTag(version) : await latestRelease();
  const result = spawnSync("sh", [join(CLI_ROOT, "install.sh"), tag], { stdio: "inherit" });
  if (result.status !== 0) throw new Error(`install.sh ${tag} failed (exit ${result.status})`);
}
