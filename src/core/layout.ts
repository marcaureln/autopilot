import { homedir } from "node:os";

export type HostOS = "linux" | "darwin";

export type Layout = {
  os: HostOS;
  hostFile: string;
  // One file per host secret, and repos/<owner>_<repo>.env per repo.
  secretsDir: string;
  skillsDir: string;
  release: (id: string) => string;
  current: string;
  tools: string;
  logs: { kind: "journal" } | { kind: "files"; service: string; audit: string };
  sudo: (uid: number) => string;
};

export function parseOS(value: string): HostOS {
  const os = value.trim().toLowerCase();
  if (os === "linux" || os === "darwin") return os;
  throw new Error(`"${value.trim()}" is not a supported host OS (Linux or macOS)`);
}

export function hostLayout(os: HostOS, home: string): Layout {
  if (os === "linux") {
    return {
      os,
      hostFile: "/etc/autopilot/host.json",
      secretsDir: "/etc/autopilot/secrets",
      skillsDir: "/etc/autopilot/skills",
      release: (id) => `/opt/autopilot-${id}`,
      current: "/opt/autopilot",
      tools: "/opt/autopilot-tools",
      logs: { kind: "journal" },
      // Without a second sudo, setup.sh still sees the SUDO_USER that ran `sudo autopilot update`.
      sudo: (uid) => (uid === 0 ? "" : "sudo "),
    };
  }
  // ~/.autopilot, not ~/Library/Application Support: the paths go into shell commands, so no spaces.
  const dir = `${home}/.autopilot`;
  const logs = `${home}/Library/Logs/autopilot`;
  return {
    os,
    hostFile: `${dir}/host.json`,
    secretsDir: `${dir}/secrets`,
    skillsDir: `${dir}/skills`,
    release: (id) => `${dir}/releases/${id}`,
    current: `${dir}/current`,
    tools: `${dir}/tools`,
    logs: { kind: "files", service: `${logs}/autopilot.log`, audit: `${logs}/audit.log` },
    sudo: () => "",
  };
}

// A Windows client only forwards commands, so it never uses these Linux paths.
export const LOCAL_LAYOUT = hostLayout(process.platform === "darwin" ? "darwin" : "linux", homedir());
