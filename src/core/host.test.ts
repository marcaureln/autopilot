import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadHost } from "./host.ts";

function writeHost(content: string): string {
  const path = join(mkdtempSync(join(tmpdir(), "autopilot-")), "host.json");
  writeFileSync(path, content);
  return path;
}

test("loads a host file and fills the defaults", () => {
  const host = loadHost(writeHost(`{ "app_id": 123456, "private_key_path": "/etc/autopilot/app.pem", "owners": ["marcaureln"], "allow": ["marcaureln"] }`));
  assert.equal(host.poll_interval_seconds, 60);
  assert.equal(host.docker, "rootless");
});

test("rejects a host file with no owners", () => {
  const path = writeHost(`{ "app_id": 123456, "private_key_path": "/etc/autopilot/app.pem", "owners": [], "allow": ["marcaureln"] }`);
  assert.throws(() => loadHost(path), /owners/);
});
