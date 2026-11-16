// Guardrails for a repo's .devcontainer/. The repo controls these files, and the host runs them, so a
// setting that reaches outside the container (host commands, host mounts, more privileges, host
// namespaces) is refused before anything starts. The checks run on the merged configuration, because
// a feature can add privileges too.

// An exact version: a digest, or a tag with a digit that is not "latest". "lts" or "stable" move.
export function imageProblem(image: string): string | undefined {
  if (image.includes("$")) return `the image ${image} has a variable that is not set`;
  if (/@sha256:[0-9a-f]{64}$/.test(image)) return undefined;
  const name = image.slice(image.lastIndexOf("/") + 1);
  const tag = name.includes(":") ? name.slice(name.indexOf(":") + 1) : undefined;
  if (tag === undefined || tag === "latest" || !/\d/.test(tag)) return `the image ${image} has no exact version tag (for example node:26.13.1)`;
  return undefined;
}

function isSet(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object" && value !== null) return Object.keys(value).length > 0;
  return value !== undefined && value !== null && value !== false && value !== "";
}

const DEVCONTAINER_REFUSED: Record<string, string> = {
  initializeCommand: "runs a command on the host",
  runArgs: "passes raw arguments to docker run",
  privileged: "gives the container full access to the host",
  capAdd: "adds Linux capabilities",
  securityOpt: "changes the security options",
  mounts: "mounts host paths or volumes",
  workspaceMount: "changes what the host mounts as the workspace",
  appPort: "publishes ports on the host",
  init: "changes the init process",
};

// `build.options` passes raw arguments to docker build. A `type=local` cache reads or writes a host path.
function buildProblems(config: Record<string, unknown>): string[] {
  const build = config.build;
  if (typeof build !== "object" || build === null) return [];
  const fields: Record<string, unknown> = { ...build };
  const problems = isSet(fields.options) ? ["devcontainer.json: `build.options` passes raw arguments to docker build"] : [];
  if ([fields.cacheFrom].flat().some((source) => typeof source === "string" && source.includes("="))) problems.push("devcontainer.json: `build.cacheFrom` can only name images");
  return problems;
}

function hostVariables(value: unknown, path: string): string[] {
  if (typeof value === "string") return /\$\{(localEnv|env):/.test(value) ? [`${path} reads a variable of the host (\${localEnv:...})`] : [];
  if (Array.isArray(value)) return value.flatMap((item, index) => hostVariables(item, `${path}[${index}]`));
  if (typeof value === "object" && value !== null) return Object.entries(value).flatMap(([key, item]) => hostVariables(item, path ? `${path}.${key}` : key));
  return [];
}

export function devcontainerProblems(config: Record<string, unknown>): string[] {
  const refused = Object.entries(DEVCONTAINER_REFUSED).flatMap(([key, why]) => (isSet(config[key]) ? [`devcontainer.json: \`${key}\` ${why}`] : []));
  const image = typeof config.image === "string" ? imageProblem(config.image) : undefined;
  return [...refused, ...buildProblems(config), ...(image ? [`devcontainer.json: ${image}`] : []), ...hostVariables(config, "").map((problem) => `devcontainer.json: ${problem}`)];
}

type ComposeVolume = { type?: string; source?: string };
type Named = Record<string, Record<string, unknown> | null>;
export type ComposeConfig = { name?: string; services?: Record<string, Record<string, unknown>>; volumes?: Named; networks?: Named; secrets?: Named; configs?: Named };

// Returns the real path, with the symlinks resolved, or undefined if it does not exist.
export type Resolve = (path: string) => string | undefined;

function within(path: string, root: string): boolean {
  return path === root || path.startsWith(`${root}/`);
}

const SERVICE_REFUSED = ["cap_add", "security_opt", "devices", "device_cgroup_rules", "ports", "volumes_from", "cgroup_parent", "runtime"];
const NAMESPACES = ["network_mode", "pid", "ipc", "userns_mode", "uts", "cgroup"];
// Other build fields reach the host: caches with a host path, entitlements, privileges, the ssh agent, tags.
const BUILD_ALLOWED = new Set(["context", "dockerfile", "dockerfile_inline", "args", "target", "labels"]);
// Compose names a volume or a network <project>_<key>. Another name can join one that already exists on the host.
const VOLUME_ALLOWED = new Set(["name", "driver", "labels"]);
const NETWORK_ALLOWED = new Set(["name", "driver", "labels", "ipam", "internal", "attachable", "enable_ipv6"]);

// The input is `docker compose config --format json`: paths are absolute and the short forms are
// expanded. A path can still go through a symlink, so each one is resolved before the check.
export function composeProblems(compose: ComposeConfig, workspace: string, resolve: Resolve): string[] {
  const inRepo = (path: string | undefined) => {
    const real = path === undefined ? undefined : resolve(path);
    return real !== undefined && within(real, workspace);
  };
  const services = Object.entries(compose.services ?? {}).flatMap(([name, service]) => {
    const problems: string[] = [];
    const add = (problem: string) => problems.push(`compose service ${name}: ${problem}`);
    if (isSet(service.privileged)) add("`privileged` gives the container full access to the host");
    for (const key of SERVICE_REFUSED) if (isSet(service[key])) add(`\`${key}\` is not allowed`);
    for (const key of NAMESPACES) {
      const value = service[key];
      if (value === "host" || (typeof value === "string" && value.startsWith("container:"))) add(`\`${key}: ${value}\` shares a namespace of the host or of another container`);
    }
    const volumes: ComposeVolume[] = Array.isArray(service.volumes) ? service.volumes : [];
    for (const volume of volumes) {
      if (volume.type === "bind" && !inRepo(volume.source)) add(`the bind mount of ${volume.source} is outside the repo`);
    }
    const envFiles: unknown[] = Array.isArray(service.env_file) ? service.env_file : [];
    for (const file of envFiles) {
      const path = typeof file === "string" ? file : typeof file === "object" && file !== null && "path" in file ? String(file.path) : undefined;
      // Compose reads nothing from a missing optional file.
      const real = path === undefined ? undefined : (resolve(path) ?? path);
      if (real === undefined || !within(real, workspace)) add(`the env_file ${path} is outside the repo`);
    }
    const build = service.build;
    if (typeof build === "object" && build !== null) {
      const fields: Record<string, unknown> = { ...build };
      for (const key of Object.keys(fields)) if (!BUILD_ALLOWED.has(key) && isSet(fields[key])) add(`\`build.${key}\` is not allowed`);
      if (typeof fields.context === "string" && !inRepo(fields.context)) add(`the build context ${fields.context} is outside the repo`);
      // Compose tags the build with `image`, which could replace an image of the host.
      if (service.image !== undefined) add("a service with `build` cannot set `image`");
    }
    if (typeof service.image === "string" && service.build === undefined) {
      const image = imageProblem(service.image);
      if (image) add(image);
    }
    return problems;
  });
  const named = (kind: "volume" | "network", entries: Named | undefined, allowed: Set<string>, driver: string) =>
    Object.entries(entries ?? {}).flatMap(([key, entry]) => {
      if (!entry) return [];
      const fields = Object.keys(entry).filter((field) => !allowed.has(field) && isSet(entry[field]));
      const problems = fields.map((field) => `compose ${kind} ${key}: \`${field}\` is not allowed`);
      if (entry.driver !== undefined && entry.driver !== driver) problems.push(`compose ${kind} ${key}: only the ${driver} driver is allowed`);
      if (entry.name !== undefined && entry.name !== `${compose.name}_${key}`) problems.push(`compose ${kind} ${key}: a custom name can join a ${kind} of the host`);
      return problems;
    });
  const volumes = [...named("volume", compose.volumes, VOLUME_ALLOWED, "local"), ...named("network", compose.networks, NETWORK_ALLOWED, "bridge")];
  // Secrets and configs come from a file in the repo or from inline content, never from the host.
  const files = (["secrets", "configs"] as const).flatMap((kind) =>
    Object.entries(compose[kind] ?? {}).flatMap(([name, entry]) => {
      if (!entry) return [];
      if (isSet(entry.environment) || isSet(entry.external)) return [`compose ${kind} ${name}: only a file in the repo or inline content is allowed`];
      if (typeof entry.file === "string" && !inRepo(entry.file)) return [`compose ${kind} ${name}: the file ${entry.file} is outside the repo`];
      return [];
    }),
  );
  return [...services, ...volumes, ...files];
}

// Each FROM must name an exact image, an earlier stage, or scratch. ARG defaults before the first FROM apply.
export function dockerfileProblems(text: string): string[] {
  const args = new Map<string, string>();
  const stages = new Set<string>();
  const problems: string[] = [];
  let seenFrom = false;
  for (const line of text.replace(/\\\n/g, " ").split("\n")) {
    const words = line.trim().split(/\s+/);
    const instruction = words[0]?.toUpperCase();
    if (instruction === "ARG" && !seenFrom) {
      const [key = "", value] = (words[1] ?? "").split("=");
      if (value !== undefined) args.set(key, value);
      continue;
    }
    if (instruction !== "FROM") continue;
    seenFrom = true;
    const rest = words.slice(1).filter((word) => !word.startsWith("--"));
    const raw = rest[0] ?? "";
    if (rest[1]?.toUpperCase() === "AS" && rest[2]) stages.add(rest[2].toLowerCase());
    const image = raw.replace(/\$\{(\w+)\}|\$(\w+)/g, (match, braced: string | undefined, bare: string | undefined) => args.get(braced ?? bare ?? "") ?? match);
    if (image === "scratch" || stages.has(image.toLowerCase())) continue;
    const problem = imageProblem(image);
    if (problem) problems.push(`Dockerfile: ${problem}`);
  }
  return problems;
}
