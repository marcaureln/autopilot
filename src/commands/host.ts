import { execFileSync, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import type { Host } from "../core/host.ts";

const CLI_ROOT = new URL("../../", import.meta.url).pathname;
const SETUP_SCRIPT = new URL("../../host/setup.sh", import.meta.url).pathname;
const CREDENTIALS_DIR = "/run/credentials/autopilot.service";

const SECRETS = [
  { file: "app-key", op: ["document", "get", "github-app-private-key", "--vault", "autopilot"] },
  { file: "claude-token", op: ["read", "op://autopilot/claude-token/credential"] },
  { file: "op-token", op: ["read", "op://autopilot/op-service-account-token/password"] },
];

export type Remote = {
  run(command: string, input?: Buffer | string): Promise<number>;
};

export function sshRemote(target: string): Remote {
  return {
    run(command, input) {
      return new Promise((resolve, reject) => {
        const ssh = spawn("ssh", [target, command], { stdio: ["pipe", "inherit", "inherit"] });
        ssh.on("error", reject);
        ssh.on("close", (code) => resolve(code ?? 1));
        ssh.stdin.end(input);
      });
    },
  };
}

export function remoteHostFile(host: Host): Host {
  return { ...host, private_key_path: `${CREDENTIALS_DIR}/app-key` };
}

async function must(remote: Remote, step: string, command: string, input?: Buffer | string): Promise<void> {
  const code = await remote.run(command, input);
  if (code !== 0) throw new Error(`${step} failed on the host (exit ${code})`);
}

function writeRootFile(path: string, mode: "600" | "644"): string {
  return `sudo sh -c 'set -e; install -d -m 755 /etc/autopilot; umask 077; cat > ${path}.tmp; chmod ${mode} ${path}.tmp; mv ${path}.tmp ${path}'`;
}

export async function hostSetup(remote: Remote, host: Host): Promise<void> {
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

  console.log("==> host.json");
  await must(remote, "host.json", writeRootFile("/etc/autopilot/host.json", "644"), JSON.stringify(remoteHostFile(host), null, 2) + "\n");

  await must(remote, "setup.sh", `sudo bash -s -- ${release} ${host.docker}`, readFileSync(SETUP_SCRIPT));
}

export async function hostStatus(remote: Remote): Promise<void> {
  await must(
    remote,
    "status",
    `printf 'service: '; systemctl is-active autopilot; printf 'release: '; readlink /opt/autopilot; printf 'node:    '; sudo -u autopilot -H env MISE_TRUSTED_CONFIG_PATHS=/opt mise --cd /opt/autopilot exec -- node --version; sudo journalctl -u autopilot -n 20 --no-pager --output cat`,
  );
}
