import { execFileSync, spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import type { Client } from "../core/client.ts";
import { DEFAULT_HOST_PATH, parseHost, type Host } from "../core/host.ts";

const CLI_ROOT = new URL("../../", import.meta.url).pathname;
const SETUP_SCRIPT = new URL("../../host/setup.sh", import.meta.url).pathname;
const HOST_FILE = "/etc/autopilot/host.json";
const HOST_SCHEMA = "https://raw.githubusercontent.com/marcaureln/autopilot/main/schema/host.schema.json";

const SECRETS = [
  { file: "app-key", op: ["document", "get", "github-app-private-key", "--vault", "autopilot"] },
  { file: "claude-token", op: ["read", "op://autopilot/claude-token/credential"] },
  { file: "op-token", op: ["read", "op://autopilot/op-service-account-token/password"] },
];

export type Remote = {
  run(command: string, input?: Buffer | string): Promise<number>;
  capture(command: string): Promise<{ code: number; stdout: string }>;
};

export function sshRemote(target: string): Remote {
  function ssh(command: string, input: Buffer | string | undefined, capture: boolean): Promise<{ code: number; stdout: string }> {
    return new Promise((resolve, reject) => {
      const child = spawn("ssh", [target, command], { stdio: ["pipe", capture ? "pipe" : "inherit", "inherit"] });
      let stdout = "";
      child.stdout?.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
      child.on("error", reject);
      child.on("close", (code) => resolve({ code: code ?? 1, stdout }));
      child.stdin?.end(input);
    });
  }
  return {
    run: async (command, input) => (await ssh(command, input, false)).code,
    capture: (command) => ssh(command, undefined, true),
  };
}

async function must(remote: Remote, step: string, command: string, input?: Buffer | string): Promise<void> {
  const code = await remote.run(command, input);
  if (code !== 0) throw new Error(`${step} failed on the host (exit ${code})`);
}

function writeRootFile(path: string, mode: "600" | "644"): string {
  return `sudo sh -c 'set -e; install -d -m 755 /etc/autopilot; umask 077; cat > ${path}.tmp; chmod ${mode} ${path}.tmp; mv ${path}.tmp ${path}'`;
}

function serialize(host: Host): string {
  return JSON.stringify(host, null, 2) + "\n";
}

export type HostAccess = {
  readHostFile(): Promise<Host | undefined>;
  writeHostFile(host: Host): Promise<void>;
  restart(): Promise<void>;
};

export function remoteAccess(remote: Remote): HostAccess {
  return {
    async readHostFile() {
      const { code, stdout } = await remote.capture(`sudo cat ${HOST_FILE} 2>/dev/null`);
      return code === 0 ? parseHost(stdout, HOST_FILE) : undefined;
    },
    writeHostFile: (host) => must(remote, "host.json", writeRootFile(HOST_FILE, "644"), serialize(host)),
    restart: () => must(remote, "restart", "sudo systemctl restart autopilot"),
  };
}

export function localAccess(path = DEFAULT_HOST_PATH): HostAccess {
  return {
    readHostFile: async () => (existsSync(path) ? parseHost(readFileSync(path, "utf8"), path) : undefined),
    writeHostFile: async (host) => writeFileSync(path, serialize(host)),
    restart: async () => console.log("restart `autopilot run` to apply the change"),
  };
}

export function initialHostFile(client: Client): Host {
  return {
    $schema: HOST_SCHEMA,
    app_id: client.app.id,
    private_key_path: "/run/credentials/autopilot.service/app-key",
    owners: [client.owner],
    allow: [],
    docker: "rootless",
    poll_interval_seconds: 60,
  };
}

export async function hostSetup(remote: Remote, client: Client): Promise<void> {
  if (execFileSync("git", ["status", "--porcelain"], { cwd: CLI_ROOT, encoding: "utf8" }).trim()) {
    console.warn("warning: uncommitted changes are not deployed, only HEAD is");
  }
  const commit = execFileSync("git", ["rev-parse", "--short=12", "HEAD"], { cwd: CLI_ROOT, encoding: "utf8" }).trim();
  const release = `/opt/autopilot-${commit}`;

  if ((await remote.run(`test -d ${release}`)) !== 0) {
    console.log(`==> upload ${commit}`);
    const archive = execFileSync("git", ["archive", "--format=tar", "HEAD"], { cwd: CLI_ROOT, maxBuffer: 256 * 1024 * 1024 });
    await must(remote, "upload", `sudo sh -c 'set -e; rm -rf ${release}.tmp; mkdir -p ${release}.tmp; tar -x -C ${release}.tmp; mv ${release}.tmp ${release}'`, archive);
  }

  for (const secret of SECRETS) {
    console.log(`==> secret ${secret.file}`);
    // Buffered first: if `op` fails, nothing reaches the host, so no secret is left empty.
    const value = execFileSync("op", secret.op, { stdio: ["ignore", "pipe", "inherit"] });
    await must(remote, `secret ${secret.file}`, writeRootFile(`/etc/autopilot/${secret.file}`, "600"), value);
  }

  const access = remoteAccess(remote);
  let host = await access.readHostFile();
  if (!host) {
    console.log("==> host.json (new)");
    host = initialHostFile(client);
    await access.writeHostFile(host);
  }

  await must(remote, "setup.sh", `sudo bash -s -- ${release} ${host.docker}`, readFileSync(SETUP_SCRIPT));
}

export async function hostStatus(remote: Remote): Promise<void> {
  const host = await remoteAccess(remote).readHostFile();
  console.log(`allow:   ${host?.allow.join(", ") || "(empty)"}`);
  await must(
    remote,
    "status",
    `printf 'service: '; systemctl is-active autopilot; printf 'release: '; readlink /opt/autopilot; sudo journalctl -u autopilot -n 20 --no-pager --output cat`,
  );
}
