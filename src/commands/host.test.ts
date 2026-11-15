import { test } from "node:test";
import assert from "node:assert/strict";
import { initialHostFile } from "./host.ts";

test("a new host file trusts only the client owner, allows nothing, and reads the key from the systemd credential", () => {
  const host = initialHostFile({ host: "rpi", app: { id: 42, slug: "me-autopilot" }, owner: "me" });
  assert.equal(host.app_id, 42);
  assert.deepEqual(host.owners, ["me"]);
  assert.deepEqual(host.allow, []);
  assert.equal(host.private_key_path, "/run/credentials/autopilot.service/app-key");
});
