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

function hostVariables(value: unknown, path: string): string[] {
  if (typeof value === "string") return value.includes("${localEnv:") ? [`${path} reads a variable of the host (\${localEnv:...})`] : [];
  if (Array.isArray(value)) return value.flatMap((item, index) => hostVariables(item, `${path}[${index}]`));
  if (typeof value === "object" && value !== null) return Object.entries(value).flatMap(([key, item]) => hostVariables(item, path ? `${path}.${key}` : key));
  return [];
}

export function devcontainerProblems(config: Record<string, unknown>): string[] {
  const refused = Object.entries(DEVCONTAINER_REFUSED).flatMap(([key, why]) => (isSet(config[key]) ? [`devcontainer.json: \`${key}\` ${why}`] : []));
  const image = typeof config.image === "string" ? imageProblem(config.image) : undefined;
  return [...refused, ...(image ? [`devcontainer.json: ${image}`] : []), ...hostVariables(config, "").map((problem) => `devcontainer.json: ${problem}`)];
}

type ComposeVolume = { type?: string; source?: string };

function within(path: string, root: string): boolean {
  return path === root || path.startsWith(`${root}/`);
}

// The input is `docker compose config --format json`: paths are absolute and the short forms are expanded.
export function composeProblems(compose: { services?: Record<string, Record<string, unknown>> }, workspace: string): string[] {
  return Object.entries(compose.services ?? {}).flatMap(([name, service]) => {
    const problems: string[] = [];
    const add = (problem: string) => problems.push(`compose service ${name}: ${problem}`);
    if (isSet(service.privileged)) add("`privileged` gives the container full access to the host");
    for (const key of ["cap_add", "security_opt", "devices", "ports"]) if (isSet(service[key])) add(`\`${key}\` is not allowed`);
    for (const key of ["network_mode", "pid", "ipc", "userns_mode"]) if (service[key] === "host") add(`\`${key}: host\` shares a namespace of the host`);
    const volumes: ComposeVolume[] = Array.isArray(service.volumes) ? service.volumes : [];
    for (const volume of volumes) {
      if (volume.type === "bind" && !within(volume.source ?? "", workspace)) add(`the bind mount of ${volume.source} is outside the repo`);
    }
    if (typeof service.image === "string" && service.build === undefined) {
      const image = imageProblem(service.image);
      if (image) add(image);
    }
    return problems;
  });
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
