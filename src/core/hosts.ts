import { Ajv2020 } from "ajv/dist/2020.js";
import schema from "../../schema/hosts.schema.json" with { type: "json" };

export const HOSTS_SCHEMA = "https://raw.githubusercontent.com/marcaureln/autopilot/main/schema/hosts.schema.json";
export const LOCAL_TARGET = "local";

export type HostsFile = { $schema?: string; default?: string; hosts: Record<string, { target: string }> };

export type HostRef = { savedName?: string; target: string };

export const RUN_HERE = "";

export const NO_HOSTS: HostsFile = { hosts: {} };

const HOST_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const SSH_TARGET = /^[^-\s]\S*$/;

const ajv = new Ajv2020({ allErrors: true });
const validate = ajv.compile<HostsFile>(schema);

export function nameProblem(name: string): string | undefined {
  return HOST_NAME.test(name) && name !== LOCAL_TARGET ? undefined : `"${name}" is not a host name: use letters, digits, ".", "_" and "-", and not "local"`;
}

export function parseHosts(text: string, source: string, dropUnknownDefault = false): HostsFile {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (error) {
    throw new Error(`Invalid hosts file ${source}: ${error instanceof Error ? error.message : error}. Fix the file, or move it away`);
  }
  if (!validate(data)) {
    throw new Error(`Invalid hosts file ${source}: ${ajv.errorsText(validate.errors, { dataVar: "file" })}. Fix the file, or move it away`);
  }
  const badName = Object.keys(data.hosts).find((name) => nameProblem(name));
  if (badName !== undefined) throw new Error(`Invalid hosts file ${source}: ${nameProblem(badName)}. Rename or remove it in the file`);
  if (data.default !== undefined && !Object.hasOwn(data.hosts, data.default)) {
    if (dropUnknownDefault) return { ...data, default: undefined };
    throw new Error(`Invalid hosts file ${source}: the default "${data.default}" is not one of its hosts. Set another default with autopilot hosts default <name>`);
  }
  return data;
}

function hostOf(file: HostsFile, name: string): { target: string } | undefined {
  return Object.hasOwn(file.hosts, name) ? file.hosts[name] : undefined;
}

export function resolveHost(flag: string | undefined, env: string | undefined, hosts: () => HostsFile): HostRef | undefined {
  const given = flag ?? env;
  if (given === RUN_HERE) return undefined;
  const file = hosts();
  const value = given ?? file.default;
  if (value === undefined) return undefined;
  const host = hostOf(file, value);
  if (host) return { savedName: value, target: host.target };
  if (!SSH_TARGET.test(value)) throw new Error(`"${value}" is not a host of the hosts file or an SSH target`);
  return { target: value };
}

export function nameOfTarget(file: HostsFile, target: string, localName: string): string {
  const known = Object.entries(file.hosts).find(([, host]) => host.target === target);
  if (known) return known[0];
  if (target === LOCAL_TARGET) return localName;
  return target.replace(/^ssh:\/\//, "").replace(/^.*@/, "").replace(/:\d+$/, "");
}

export function checkHost(name: string, target: string): void {
  const problem = nameProblem(name);
  if (problem) throw new Error(problem);
  if (!SSH_TARGET.test(target)) throw new Error(`"${target}" is not an SSH target`);
}

export function addHost(file: HostsFile, name: string, target: string): HostsFile {
  checkHost(name, target);
  return { ...file, default: file.default ?? name, hosts: { ...file.hosts, [name]: { target } } };
}

export function removeHost(file: HostsFile, name: string): HostsFile {
  if (!hostOf(file, name)) throw new Error(`no host named ${name} in the hosts file`);
  const hosts = Object.fromEntries(Object.entries(file.hosts).filter(([key]) => key !== name));
  return { ...file, default: file.default === name ? undefined : file.default, hosts };
}

export function setDefaultHost(file: HostsFile, name: string): HostsFile {
  if (!hostOf(file, name)) throw new Error(`no host named ${name} in the hosts file`);
  return { ...file, default: name };
}
