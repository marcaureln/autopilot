import { basename } from "node:path";
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

const REPO_ENTRY = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/;

export function isRepoEntry(value: string): boolean {
  return REPO_ENTRY.test(value);
}

export function parseList(value: string): string[] {
  return [...new Set(value.split(/[\s,]+/).filter(Boolean))];
}

export const RELEASE_TAG = /^v\d+\.\d+\.\d+$/;

export type HostFacts = { hasHost: boolean; opToken: boolean; release?: string; service: string };

export type HostPlan =
  | { kind: "ready" }
  | { kind: "refuse"; reason: string }
  | { kind: "run"; version?: string; fromCheckout: boolean; problem?: string };

// A release folder is /opt/autopilot-<tag or commit> on Linux and <dir>/releases/<tag or commit> on macOS.
function releaseId(link: string): string {
  return basename(link).replace(/^autopilot-/, "");
}

// A host that already runs a release keeps that release: setup repairs it and never upgrades it by surprise.
export function planHostSetup(facts: HostFacts, request: { version?: string; fromCheckout: boolean }): HostPlan {
  const problems = [
    ...(["active", "running"].includes(facts.service) ? [] : [`service is ${facts.service}`]),
    ...(facts.opToken ? [] : ["the 1Password token file is missing"]),
  ];
  if (facts.hasHost && facts.release !== undefined && problems.length === 0) return { kind: "ready" };
  if (!facts.hasHost || facts.release === undefined) return { kind: "run", ...request };
  const problem = problems.join("; ");
  if (request.version || request.fromCheckout) return { kind: "run", ...request, problem };
  const id = releaseId(facts.release);
  if (!RELEASE_TAG.test(id)) {
    return { kind: "refuse", reason: `${problem}, and the host runs the checkout build ${id}: setup does not replace it with a release. Pass --from-checkout to install it again from this checkout` };
  }
  return { kind: "run", version: id, fromCheckout: false, problem };
}
