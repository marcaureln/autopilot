import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, resolve } from "node:path";
import { isCancel, text } from "@clack/prompts";
import { appInstallUrl, appManifest, type CreatedApp, keyFileProblem, parseConversion, stateMatches, suggestAppName, writeFallbackKey } from "../core/app.ts";
import { SECRETS_VAULT } from "../core/repo-secrets.ts";
import type { Backend } from "../core/secrets.ts";
import { appCreatedPage, appFailedPage, appStartPage } from "../web/pages.ts";
import { APP_KEY_FILE, APP_KEY_ITEM, APP_KEY_PATH, HOST_SECRETS, openInBrowser } from "./client.ts";
import { op, opItemExists } from "./secrets.ts";

const REPO_URL = "https://github.com/marcaureln/autopilot";

export type KeyDestination = { kind: "op" } | { kind: "file"; path: string };

export type CreatedAppSummary = { id: number; slug: string; keyLocation: string; installUrl: string };

export function githubLogin(): string | undefined {
  const result = spawnSync("gh", ["api", "user", "--jq", ".login"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  const login = result.stdout?.trim();
  return result.status === 0 && login ? login : undefined;
}

async function askLogin(): Promise<string> {
  const login = githubLogin();
  if (login) return login;
  const value = await text({
    message: "Your GitHub login (gh is not signed in, so autopilot cannot read it)",
    validate: (input) => (/^[A-Za-z0-9-]+$/.test(input ?? "") ? undefined : "Use letters, digits and -"),
  });
  if (isCancel(value)) throw new Error("cancelled");
  return value;
}

// GET /apps/<slug> is public and answers 404 for a name that no App has.
async function freeAppName(login: string): Promise<string> {
  for (let attempt = 1; attempt <= 20; attempt++) {
    const name = suggestAppName(login, attempt);
    const answer = await fetch(`https://api.github.com/apps/${name}`, { headers: { accept: "application/vnd.github+json" } });
    if (answer.status === 404) return name;
    if (!answer.ok) throw new Error(`GET /apps/${name}: ${answer.status} ${await answer.text()}`);
  }
  throw new Error(`the names ${suggestAppName(login, 1)} to ${suggestAppName(login, 20)} are all taken`);
}

// GitHub shows the private key only once, so the place for it must be ready before the App exists.
function checkKeyDestination(destination: KeyDestination): void {
  if (destination.kind === "file") {
    if (destination.path === APP_KEY_PATH) {
      if (existsSync(APP_KEY_PATH)) throw new Error(`${APP_KEY_PATH} already exists: it is the key of an App that you created before. Push it to a host with autopilot hosts add, or move it away to create another App`);
      mkdirSync(dirname(APP_KEY_PATH), { recursive: true, mode: 0o700 });
    }
    const problem = keyFileProblem(destination.path);
    if (problem) throw new Error(problem);
    return;
  }
  const vault = op(["vault", "get", SECRETS_VAULT, "--format", "json"]);
  if (!vault.ok) throw new Error(`op cannot open the vault ${SECRETS_VAULT}: ${vault.stderr}. Run autopilot setup, or pass --key-out <path>`);
  if (opItemExists(APP_KEY_ITEM)) {
    throw new Error(`the vault ${SECRETS_VAULT} already has ${APP_KEY_ITEM}, the key of an App: to replace that App, rename the item in 1Password first, or pass --key-out <path>`);
  }
}

function storeKey(destination: KeyDestination, pem: string): string {
  if (destination.kind === "file") {
    writeFileSync(destination.path, pem, { mode: 0o600, flag: "wx" });
    return destination.path;
  }
  const result = op(["document", "create", "-", "--vault", SECRETS_VAULT, "--title", APP_KEY_ITEM, "--file-name", APP_KEY_FILE], pem);
  if (!result.ok) throw new Error(`op could not save the private key: ${result.stderr}`);
  return HOST_SECRETS.op.app_key;
}

function keepKeyAfterFailure(app: CreatedApp, reason: string): string {
  try {
    return writeFallbackKey(app.pem);
  } catch (error) {
    const fallback = error instanceof Error ? error.message : String(error);
    throw new Error(`the App ${app.slug} (id ${app.id}) exists and its private key is lost: ${reason}; the fallback file failed too: ${fallback}. Delete the App at https://github.com/settings/apps/${app.slug}/advanced, then run autopilot app create again`);
  }
}

function send(response: ServerResponse, status: number, html: string, then?: () => void): void {
  response.writeHead(status, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
  response.end(html, then);
}

export async function appCreate(options: { keyOut?: string; backend: Backend; workflows: boolean }): Promise<CreatedAppSummary> {
  const destination: KeyDestination = options.keyOut ? { kind: "file", path: resolve(options.keyOut) } : options.backend === "op" ? { kind: "op" } : { kind: "file", path: APP_KEY_PATH };
  checkKeyDestination(destination);
  const name = await freeAppName(await askLogin());
  const state = randomBytes(16).toString("hex");
  const created = Promise.withResolvers<CreatedAppSummary>();
  let origin = "";
  let exchanging = false;
  let startServed = false;

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    // A page from another site can reach 127.0.0.1 through DNS rebinding, but it cannot send this Host header.
    if (request.method !== "GET" || `http://${request.headers.host}` !== origin) return send(response, 404, "");
    const url = new URL(request.url ?? "/", origin);
    if (url.pathname === "/") {
      // The page carries the state, so only the first request gets it.
      if (startServed) return send(response, 404, "");
      startServed = true;
      const manifest = appManifest(name, REPO_URL, `${origin}/callback`, options.workflows);
      return send(response, 200, appStartPage({ action: `https://github.com/settings/apps/new?state=${state}`, manifest }));
    }
    const code = url.searchParams.get("code");
    if (url.pathname !== "/callback" || !code || !stateMatches(state, url.searchParams.get("state"))) {
      return send(response, 400, appFailedPage("The answer does not come from the App creation that this command started."));
    }
    if (exchanging) return send(response, 409, appFailedPage("This command already received an App from GitHub."));
    exchanging = true;
    const answer = await fetch(`https://api.github.com/app-manifests/${encodeURIComponent(code)}/conversions`, {
      method: "POST",
      headers: { accept: "application/vnd.github+json" },
    });
    if (!answer.ok) {
      const message = `POST /app-manifests/{code}/conversions: ${answer.status} ${await answer.text()}`;
      return send(response, 502, appFailedPage(message), () => created.reject(new Error(message)));
    }
    const app = parseConversion(await answer.json());
    const installUrl = appInstallUrl(app.slug);
    let keyLocation: string;
    try {
      keyLocation = storeKey(destination, app.pem);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      const keyPath = keepKeyAfterFailure(app, reason);
      const message = `the App ${app.slug} (id ${app.id}) exists, but ${reason}. Its private key is in ${keyPath}: move it to a safe place. Install the App: ${installUrl}`;
      return send(response, 500, appFailedPage(reason, { slug: app.slug, id: app.id, keyPath }), () => created.reject(new Error(message)));
    }
    const summary = { id: app.id, slug: app.slug, keyLocation, installUrl };
    send(response, 200, appCreatedPage({ slug: app.slug, id: app.id, keyPath: summary.keyLocation, installUrl: summary.installUrl }), () => created.resolve(summary));
  }

  const server = createServer((request, response) => {
    handle(request, response).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      if (!response.headersSent) send(response, 500, appFailedPage(message));
      created.reject(error);
    });
  });
  await new Promise<void>((listening) => server.listen(0, "127.0.0.1", listening));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  console.log(`Create the GitHub App ${name} in your browser: ${origin}/`);
  openInBrowser(`${origin}/`);
  try {
    const summary = await created.promise;
    console.log(`App created: ${summary.slug} (id ${summary.id})`);
    console.log(`private key: ${summary.keyLocation}`);
    if (summary.keyLocation === APP_KEY_PATH) console.log("autopilot hosts add pushes it to the host");
    console.log(`install it on All repositories: ${summary.installUrl}`);
    return summary;
  } finally {
    server.close();
    server.closeAllConnections();
  }
}
