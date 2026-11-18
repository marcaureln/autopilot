import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

// The XDG spec says to ignore a relative XDG_CONFIG_HOME.
export function configDirOf(xdgConfigHome: string | undefined, home: string): string {
  return join(xdgConfigHome && isAbsolute(xdgConfigHome) ? xdgConfigHome : join(home, ".config"), "autopilot");
}

export const CONFIG_DIR = configDirOf(process.env.XDG_CONFIG_HOME, homedir());
