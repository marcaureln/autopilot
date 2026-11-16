import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

export type LoginShell = "zsh" | "bash" | "fish";

const MARKER = "# autopilot alias";
const NAME = /^[A-Za-z_][A-Za-z0-9_-]*$/;

export function shellOf(path: string | undefined): LoginShell {
  const name = basename(path ?? "");
  if (name === "zsh" || name === "bash" || name === "fish") return name;
  throw new Error(`SHELL is "${path ?? ""}": the alias command knows zsh, bash or fish`);
}

// Terminal apps on macOS start bash as a login shell, which reads ~/.bash_profile and not ~/.bashrc.
export function aliasFile(shell: LoginShell, platform: NodeJS.Platform, home: string): string {
  if (shell === "fish") return join(home, ".config", "fish", "conf.d", "autopilot.fish");
  if (shell === "bash") return join(home, platform === "darwin" ? ".bash_profile" : ".bashrc");
  return join(home, ".zshrc");
}

export function aliasLine(shell: LoginShell, name: string): string {
  return shell === "fish" ? `alias ${name} autopilot ${MARKER}` : `alias ${name}='autopilot' ${MARKER}`;
}

// setup skips the alias on this error and stops on any other.
export class AliasError extends Error {}

export function aliasNameProblem(value: string): string | undefined {
  return NAME.test(value) ? undefined : `"${value}" is not an alias name: use letters, digits, - and _`;
}

export function parseAliasName(value: string): string {
  const problem = aliasNameProblem(value);
  if (problem) throw new AliasError(problem);
  return value;
}

export function withoutAlias(text: string): string {
  return text
    .split("\n")
    .filter((line) => !line.endsWith(MARKER))
    .join("\n");
}

export function withAlias(text: string, line: string): string {
  const rest = withoutAlias(text);
  return `${rest}${rest === "" || rest.endsWith("\n") ? "" : "\n"}${line}\n`;
}

// The aliases live in rc files. bash -i reads ~/.bashrc and bash -l -i reads ~/.bash_profile.
function taken(shell: string, name: string): boolean {
  return [["-i"], ["-l", "-i"]].some((flags) => spawnSync(shell, [...flags, "-c", `type ${name}`], { stdio: "ignore", timeout: 10_000 }).status === 0);
}

export function alias(value: string | undefined, remove: boolean): void {
  const shellPath = process.env.SHELL;
  const shell = shellOf(shellPath);
  const file = aliasFile(shell, process.platform, homedir());
  const text = existsSync(file) ? readFileSync(file, "utf8") : "";

  if (remove) {
    const rest = withoutAlias(text);
    if (rest === text) return console.log(`no autopilot alias in ${file}`);
    if (shell === "fish" && rest === "") unlinkSync(file);
    else writeFileSync(file, rest);
    return console.log(`removed the autopilot alias from ${file}. Open a new shell to drop it from this session.`);
  }

  const name = parseAliasName(value ?? "ap");
  const line = aliasLine(shell, name);
  if (text.split("\n").includes(line)) return console.log(`${name} is already an alias for autopilot in ${file}`);
  if (taken(shellPath ?? shell, name)) throw new AliasError(`${name} is already a command or an alias in ${shell}: choose another name, for example autopilot alias ${name}x`);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, withAlias(text, line));
  console.log(`added "${line}" to ${file}. To use it in this shell now, run:\n  source ${file}`);
}
