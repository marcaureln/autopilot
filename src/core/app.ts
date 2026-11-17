import { timingSafeEqual } from "node:crypto";
import { accessSync, constants, existsSync, mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const APP_PERMISSIONS = {
  metadata: "read",
  contents: "write",
  issues: "write",
  pull_requests: "write",
  statuses: "write",
  checks: "read",
} as const;

export type AppManifest = {
  name: string;
  url: string;
  public: true;
  redirect_url: string;
  hook_attributes: { url: string; active: false };
  default_permissions: typeof APP_PERMISSIONS;
  default_events: [];
};

export type CreatedApp = { id: number; slug: string; htmlUrl: string; pem: string };

const SUFFIX = "-autopilot";
// GitHub refuses App names longer than 34 characters.
const NAME_MAX = 34;

// App names are unique on all of GitHub, so a later attempt adds a number.
export function suggestAppName(login: string, attempt: number): string {
  const suffix = attempt === 1 ? SUFFIX : `${SUFFIX}-${attempt}`;
  return `${login.toLowerCase().slice(0, NAME_MAX - suffix.length)}${suffix}`;
}

// GitHub wants a hook URL in the manifest, also for an inactive hook.
export function appManifest(name: string, homepage: string, redirectUrl: string): AppManifest {
  return {
    name,
    url: homepage,
    public: true,
    redirect_url: redirectUrl,
    hook_attributes: { url: homepage, active: false },
    default_permissions: APP_PERMISSIONS,
    default_events: [],
  };
}

export function stateMatches(expected: string, received: string | null): boolean {
  if (received === null) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(received);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function parseConversion(data: unknown): CreatedApp {
  if (
    typeof data !== "object" ||
    data === null ||
    !("id" in data && typeof data.id === "number") ||
    !("slug" in data && typeof data.slug === "string") ||
    !("html_url" in data && typeof data.html_url === "string") ||
    !("pem" in data && typeof data.pem === "string")
  ) {
    throw new Error("GitHub returned an App without id, slug, html_url or private key");
  }
  return { id: data.id, slug: data.slug, htmlUrl: data.html_url, pem: data.pem };
}

export function appInstallUrl(slug: string): string {
  return `https://github.com/apps/${slug}/installations/new`;
}

// GitHub shows the private key only once, so a bad --key-out must fail before the App is created.
export function keyFileProblem(path: string): string | undefined {
  if (existsSync(path)) return `${path} already exists: pass another --key-out path`;
  const dir = dirname(path);
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return `the folder ${dir} does not exist: create it or pass another --key-out path`;
  try {
    accessSync(dir, constants.W_OK);
  } catch {
    return `the folder ${dir} is not writable: pass another --key-out path`;
  }
  return undefined;
}

// Last resort when the chosen place for the key fails after the App exists. The private folder keeps other users out.
export function writeFallbackKey(pem: string, base = tmpdir()): string {
  const path = join(mkdtempSync(join(base, "autopilot-key-")), "app.pem");
  writeFileSync(path, pem, { mode: 0o600, flag: "wx" });
  return path;
}
