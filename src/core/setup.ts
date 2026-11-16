import { Ajv2020 } from "ajv/dist/2020.js";
import schema from "../../schema/setup.schema.json" with { type: "json" };

export type SetupConfig = {
  $schema?: string;
  app_id?: number;
  host?: string;
  owner?: string;
  allow?: string[];
  init?: string[];
  alias?: string | false;
};

const ajv = new Ajv2020({ allErrors: true });
const validate = ajv.compile<SetupConfig>(schema);

export function parseSetupConfig(text: string, source: string): SetupConfig {
  const data: unknown = JSON.parse(text);
  if (!validate(data)) throw new Error(`Invalid setup file ${source}: ${ajv.errorsText(validate.errors, { dataVar: "setup" })}`);
  return data;
}

export const TOOLS = ["git", "ssh", "mise", "op", "gh"] as const;
export type Tool = (typeof TOOLS)[number];

const INSTALL: Record<Tool, { darwin: string; linux: string }> = {
  git: { darwin: "xcode-select --install", linux: "sudo apt-get install -y git" },
  ssh: { darwin: "macOS includes ssh: reinstall the command line tools with xcode-select --install", linux: "sudo apt-get install -y openssh-client" },
  mise: { darwin: "curl https://mise.run | sh", linux: "curl https://mise.run | sh" },
  op: { darwin: "brew install 1password-cli", linux: "see https://developer.1password.com/docs/cli/get-started/" },
  gh: { darwin: "brew install gh", linux: "see https://github.com/cli/cli/blob/trunk/docs/install_linux.md" },
};

export function installCommand(tool: Tool, platform: NodeJS.Platform): string {
  return INSTALL[tool][platform === "darwin" ? "darwin" : "linux"];
}

export type HostResources = { arch: string; memoryBytes: number; diskBytes: number };

export const RESOURCES_PROBE = [
  "uname -m",
  `case $(uname -s) in Darwin) sysctl -n hw.memsize ;; *) awk '/^MemTotal:/ { printf "%.0f\\n", $2 * 1024 }' /proc/meminfo ;; esac`,
  `df -Pk "$HOME" | awk 'NR == 2 { printf "%.0f\\n", $4 * 1024 }'`,
].join("; ");

export function parseResources(stdout: string): HostResources {
  const [arch, memory, disk] = stdout.trim().split("\n").map((line) => line.trim());
  const memoryBytes = Number(memory);
  const diskBytes = Number(disk);
  if (!arch || !memory || !disk || !Number.isFinite(memoryBytes) || !Number.isFinite(diskBytes)) {
    throw new Error(`cannot read the architecture, memory and disk of the host from: ${JSON.stringify(stdout)}`);
  }
  return { arch, memoryBytes, diskBytes };
}

const ARCHES = ["x86_64", "amd64", "aarch64", "arm64"];
const GIB = 1024 ** 3;
const MIN_MEMORY = 6 * GIB;
const MIN_DISK = 20 * GIB;

export type HostCheck = { errors: string[]; warnings: string[] };

export function checkResources(resources: HostResources): HostCheck {
  const gib = (bytes: number) => `${(bytes / GIB).toFixed(1)} GiB`;
  return {
    errors: ARCHES.includes(resources.arch) ? [] : [`the host is ${resources.arch}: autopilot hosts are x86_64 or arm64`],
    warnings: [
      ...(resources.memoryBytes < MIN_MEMORY ? [`the host has ${gib(resources.memoryBytes)} of memory: an agent container can use 6 GiB`] : []),
      ...(resources.diskBytes < MIN_DISK ? [`the host has ${gib(resources.diskBytes)} of free disk: the images and worktrees need about 20 GiB`] : []),
    ],
  };
}

export function describeResources(resources: HostResources): string {
  return `${resources.arch}, ${(resources.memoryBytes / GIB).toFixed(1)} GiB memory, ${(resources.diskBytes / GIB).toFixed(0)} GiB free disk`;
}

export function parseList(value: string): string[] {
  return [...new Set(value.split(/[\s,]+/).filter(Boolean))];
}
