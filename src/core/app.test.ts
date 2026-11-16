import { test } from "node:test";
import assert from "node:assert/strict";
import { appInstallUrl, appManifest, parseConversion, stateMatches, suggestAppName } from "./app.ts";

const names: { login: string; expected: string }[] = [
  { login: "octocat", expected: "octocat-autopilot" },
  { login: "Example-User", expected: "example-user-autopilot" },
  { login: "a-very-long-login-name-of-39-chars-xx", expected: "a-very-long-login-name-o-autopilot" },
];

for (const { login, expected } of names) {
  test(`suggests ${expected} for ${login}`, () => {
    const name = suggestAppName(login);
    assert.equal(name, expected);
    assert.ok(name.length <= 34);
  });
}

test("the manifest makes a public App with the autopilot permissions and no webhook", () => {
  const manifest = appManifest("octocat-autopilot", "https://example.com/autopilot", "http://127.0.0.1:4321/callback");
  assert.deepEqual(manifest, {
    name: "octocat-autopilot",
    url: "https://example.com/autopilot",
    public: true,
    redirect_url: "http://127.0.0.1:4321/callback",
    hook_attributes: { url: "https://example.com/autopilot", active: false },
    default_permissions: { metadata: "read", contents: "write", issues: "write", pull_requests: "write", statuses: "write", checks: "read" },
    default_events: [],
  });
});

const states: { received: string | null; expected: boolean }[] = [
  { received: "0123456789abcdef", expected: true },
  { received: "0123456789abcdeX", expected: false },
  { received: "0123456789abcdef0", expected: false },
  { received: "", expected: false },
  { received: null, expected: false },
];

for (const { received, expected } of states) {
  test(`state ${JSON.stringify(received)} ${expected ? "matches" : "does not match"}`, () => {
    assert.equal(stateMatches("0123456789abcdef", received), expected);
  });
}

test("the conversion keeps the id, slug, page and key, and drops the other secrets", () => {
  const app = parseConversion({
    id: 42,
    slug: "octocat-autopilot",
    html_url: "https://github.com/apps/octocat-autopilot",
    pem: "-----BEGIN RSA PRIVATE KEY-----\n...",
    client_id: "Iv1.x",
    client_secret: "secret",
    webhook_secret: "secret",
  });
  assert.deepEqual(app, { id: 42, slug: "octocat-autopilot", htmlUrl: "https://github.com/apps/octocat-autopilot", pem: "-----BEGIN RSA PRIVATE KEY-----\n..." });
});

for (const data of [null, "text", { id: "42", slug: "a", html_url: "b", pem: "c" }, { id: 42, slug: "a", html_url: "b" }]) {
  test(`refuses the conversion ${JSON.stringify(data)}`, () => {
    assert.throws(() => parseConversion(data), /GitHub returned/);
  });
}

test("the install page is the App's new installation page", () => {
  assert.equal(appInstallUrl("octocat-autopilot"), "https://github.com/apps/octocat-autopilot/installations/new");
});
