import { timingSafeEqual } from "node:crypto";

export const APP_PERMISSIONS = {
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

export function suggestAppName(login: string): string {
  return `${login.toLowerCase().slice(0, NAME_MAX - SUFFIX.length)}${SUFFIX}`;
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
