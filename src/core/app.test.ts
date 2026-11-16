import { after, test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appInstallUrl, appManifest, keyFileProblem, parseConversion, stateMatches, suggestAppName, writeFallbackKey } from "./app.ts";

const names: { login: string; attempt: number; expected: string }[] = [
  { login: "octocat", attempt: 1, expected: "octocat-autopilot" },
  { login: "Example-User", attempt: 1, expected: "example-user-autopilot" },
  { login: "a-very-long-login-name-of-39-chars-xx", attempt: 1, expected: "a-very-long-login-name-o-autopilot" },
  { login: "octocat", attempt: 2, expected: "octocat-autopilot-2" },
  { login: "a-very-long-login-name-of-39-chars-xx", attempt: 12, expected: "a-very-long-login-nam-autopilot-12" },
];

for (const { login, attempt, expected } of names) {
  test(`suggests ${expected} for ${login} at attempt ${attempt}`, () => {
    const name = suggestAppName(login, attempt);
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

const scratch = mkdtempSync(join(tmpdir(), "autopilot-test-"));
mkdirSync(join(scratch, "writable"));
mkdirSync(join(scratch, "readonly"));
chmodSync(join(scratch, "readonly"), 0o500);
writeFileSync(join(scratch, "writable", "taken.pem"), "x");
writeFileSync(join(scratch, "plain-file"), "x");
after(() => {
  chmodSync(join(scratch, "readonly"), 0o700);
  rmSync(scratch, { recursive: true });
});
const isRoot = process.getuid?.() === 0;

const keyFiles: { name: string; path: string; problem: RegExp | undefined; skip?: boolean }[] = [
  { name: "a new file in a writable folder", path: join(scratch, "writable", "app.pem"), problem: undefined },
  { name: "a file that exists", path: join(scratch, "writable", "taken.pem"), problem: /already exists/ },
  { name: "a folder that does not exist", path: join(scratch, "missing", "app.pem"), problem: /does not exist/ },
  { name: "a parent that is a file", path: join(scratch, "plain-file", "app.pem"), problem: /does not exist/ },
  { name: "a read-only folder", path: join(scratch, "readonly", "app.pem"), problem: /not writable/, skip: isRoot },
];

for (const { name, path, problem, skip } of keyFiles) {
  test(`key file: ${name}`, { skip }, () => {
    const result = keyFileProblem(path);
    if (problem) assert.match(result ?? "", problem);
    else assert.equal(result, undefined);
  });
}

test("the fallback key goes to a private folder, in a file only the owner reads", () => {
  const path = writeFallbackKey("PEM", scratch);
  assert.equal(readFileSync(path, "utf8"), "PEM");
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.equal(statSync(join(path, "..")).mode & 0o777, 0o700);
});

test("two fallback keys never share a file", () => {
  assert.notEqual(writeFallbackKey("A", scratch), writeFallbackKey("B", scratch));
});
