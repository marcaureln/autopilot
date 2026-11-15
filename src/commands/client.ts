import { execFile, execFileSync, spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { HOST_FILE, parseHost, type Host } from "../core/host.ts";
import { installRelease, latestRelease, must, parseTag, sshShell, type Release, type Shell } from "./host.ts";

const CLI_ROOT = new URL("../../", import.meta.url).pathname;
const HOST_SCHEMA = "https://raw.githubusercontent.com/marcaureln/autopilot/main/schema/host.schema.json";
const OP_TOKEN_REFERENCE = "op://autopilot/op-service-account-token/password";
const SECRETS: Host["secrets"] = {
  app_key: "op://autopilot/github-app-private-key/app.pem",
  claude_token: "op://autopilot/claude-token/credential",
};

export function shellQuote(arg: string): string {
  return `'${arg.replaceAll("'", `'\\''`)}'`;
}

// Forwarded output can carry text from GitHub or from agents, so the client opens only the page that `allow` prints.
export function urlToOpen(command: string, line: string): string | undefined {
  if (command !== "allow") return undefined;
  return /^open: (https:\/\/github\.com\/apps\/[a-z0-9-]+\/installations\/new\/permissions\?target_id=\d+)$/.exec(line)?.[1];
}

function openInBrowser(url: string): void {
  execFile(process.platform === "darwin" ? "open" : "xdg-open", [url], () => {});
}

export function forward(target: string, args: string[]): Promise<number> {
  const child = spawn("ssh", [target, `sudo autopilot ${args.map(shellQuote).join(" ")}`], { stdio: ["inherit", "pipe", "inherit"] });
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

function writeRootFile(path: string, mode: "600" | "644"): string {
  return `sudo sh -c 'set -e; install -d -m 755 /etc/autopilot; umask 077; cat > ${path}.tmp; chmod ${mode} ${path}.tmp; mv ${path}.tmp ${path}'`;
}

export function initialHostFile({ name, owner, appId }: { name: string; owner: string; appId: number }): Host {
  return {
    $schema: HOST_SCHEMA,
    name,
    app_id: appId,
    secrets: SECRETS,
    owners: [owner],
    allow: [],
    docker: "rootless",
    poll_interval_seconds: 60,
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

async function hostFile(remote: Shell, options: { owner?: string; appId?: number }): Promise<Host> {
  const { code, stdout } = await remote.capture(`sudo cat ${HOST_FILE} 2>/dev/null`);
  if (code === 0) return parseHost(stdout, HOST_FILE);
  if (!options.owner || !options.appId) throw new Error("the host has no host.json yet: pass --owner <login> --app-id <id>");
  const name = (await remote.capture("hostname -s")).stdout.trim().toLowerCase();
  const text = JSON.stringify(initialHostFile({ name, owner: options.owner, appId: options.appId }), null, 2) + "\n";
  const host = parseHost(text, "the new host.json");
  console.log(`==> host.json (new, host name ${host.name})`);
  await must(remote, "host.json", writeRootFile(HOST_FILE, "644"), Buffer.from(text));
  return host;
}

export async function hostSetup(target: string, options: { owner?: string; appId?: number; version?: string; fromCheckout: boolean }): Promise<void> {
  const release: Release = options.fromCheckout ? checkoutRelease() : { kind: "github", tag: options.version ? parseTag(options.version) : await latestRelease() };
  const remote = sshShell(target);

  console.log("==> 1Password service account token");
  const token = execFileSync("op", ["read", "--no-newline", OP_TOKEN_REFERENCE], { stdio: ["ignore", "pipe", "inherit"] });
  await must(remote, "op token", writeRootFile("/etc/autopilot/op-token", "600"), token);

  const host = await hostFile(remote, options);
  await installRelease(remote, release, host.docker);
}
