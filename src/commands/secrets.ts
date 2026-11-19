import type { Repo } from "../core/repo.ts";
import { readOptionFile } from "../core/option-file.ts";
import type { Audit } from "../core/audit.ts";
import { readRepoSecrets, repoSecretNames, writeRepoSecrets } from "../core/secrets.ts";
import { forward } from "./client.ts";
import { assertEnvFileValues, envFile, parseEnvFile, parseSecretsFile, SECRET_NAME } from "../core/repo-secrets.ts";

export type SecretsCommand = { action: "set"; name: string } | { action: "set-from-env"; file: string } | { action: "list" } | { action: "rm"; name: string } | { action: "import" };

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

function readHidden(prompt: string): Promise<string> {
  const stdin = process.stdin;
  stdin.setRawMode(true);
  process.stderr.write(prompt);
  stdin.resume();
  stdin.setEncoding("utf8");
  return new Promise((resolve, reject) => {
    let value = "";
    const done = (error?: Error) => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.off("data", onData);
      process.stderr.write("\n");
      if (error) reject(error);
      else resolve(value);
    };
    const onData = (keys: string) => {
      for (const key of keys) {
        if (key === "\r" || key === "\n") return done();
        if (key === "\u0003") return done(new Error("cancelled"));
        if (key === "\u007f" || key === "\b") value = value.slice(0, -1);
        else value += key;
      }
    };
    stdin.on("data", onData);
  });
}

async function readValue(name: string): Promise<string> {
  const value = process.stdin.isTTY ? await readHidden(`Value for ${name} (hidden): `) : (await readStdin()).replace(/\r?\n$/, "");
  if (value.length === 0) throw new Error(`no value for ${name}`);
  return value;
}

async function valuesOf(command: { action: "set"; name: string } | { action: "set-from-env"; file: string }): Promise<Record<string, string>> {
  const values = command.action === "set" ? { [command.name]: await readValue(command.name) } : Object.fromEntries(parseEnvFile(readOptionFile("--from-env", command.file)));
  if (Object.keys(values).length === 0) throw new Error(`no secret in ${command.action === "set-from-env" ? command.file : "the input"}`);
  assertEnvFileValues(values);
  return values;
}

// ---- The values live in the repo's env file on the host ----

// On the client.
export async function sendSecrets(target: string, command: SecretsCommand, repo: Repo): Promise<number> {
  const repoArgs = ["--repo", `${repo.owner}/${repo.name}`];
  switch (command.action) {
    case "set":
    case "set-from-env": {
      const values = await valuesOf(command);
      return forward(target, ["secrets", "import", ...repoArgs], envFile(values));
    }
    case "list":
      return forward(target, ["secrets", "list", ...repoArgs]);
    case "rm":
      return forward(target, ["secrets", "rm", command.name, ...repoArgs]);
    case "import":
      throw new Error("secrets import runs on the host");
  }
}

// On the host, through `sudo autopilot`.
export async function hostSecrets(command: SecretsCommand, repo: Repo, audit: Audit): Promise<void> {
  const name = `${repo.owner}/${repo.name}`;
  const current = () => readRepoSecrets(repo, "secrets: update the repo file", audit);
  switch (command.action) {
    case "import": {
      const values = parseSecretsFile(await readStdin());
      writeRepoSecrets(repo, { ...current(), ...values });
      audit({ event: "secrets.changed", repo: name, action: "set", names: Object.keys(values), by: process.env.SUDO_USER });
      return console.log(`Saved ${Object.keys(values).join(", ")} for ${name} on this host. The next checks get them.`);
    }
    case "rm": {
      const values = current();
      if (!Object.hasOwn(values, command.name)) return console.log(`${name} has no secret ${command.name} on this host.`);
      delete values[command.name];
      writeRepoSecrets(repo, values);
      audit({ event: "secrets.changed", repo: name, action: "rm", names: [command.name], by: process.env.SUDO_USER });
      return console.log(`Removed ${command.name} for ${name}.`);
    }
    case "list": {
      const names = repoSecretNames(repo);
      return console.log(names.length > 0 ? names.join("\n") : `${name} has no secrets on this host.`);
    }
    default:
      throw new Error(`secrets ${command.action} runs on the client: add a host with autopilot hosts add, or pass --host`);
  }
}

export function parseSecretsCommand(positionals: string[], fromEnv: string | undefined): SecretsCommand {
  const [action, name, ...rest] = positionals;
  const usage = "usage: autopilot secrets set <NAME> | set --from-env <file> | list | rm <NAME> [--repo <owner>/<repo>]";
  const checked = (value: string | undefined): string => {
    if (!value) throw new Error(usage);
    if (!SECRET_NAME.test(value)) throw new Error(`"${value}" is not a secret name (A-Z, 0-9 and _)`);
    return value;
  };
  if (action === "set" && rest.length > 0) throw new Error("a value is never an argument: type it at the hidden prompt, pipe it on stdin, or use --from-env <file>");
  if (rest.length > 0) throw new Error(usage);
  if (action === "set" && fromEnv !== undefined && name === undefined) return { action: "set-from-env", file: fromEnv };
  if (action === "set" && fromEnv === undefined) return { action: "set", name: checked(name) };
  if (action === "rm") return { action: "rm", name: checked(name) };
  if (action === "list" && name === undefined) return { action: "list" };
  if (action === "import" && name === undefined) return { action: "import" };
  throw new Error(usage);
}
