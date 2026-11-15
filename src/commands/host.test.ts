import { test } from "node:test";
import assert from "node:assert/strict";
import { remoteHostFile } from "./host.ts";

test("the host file on the host reads the App key from the systemd credential", () => {
  const laptop = { app_id: 1, private_key_path: "/Users/me/.config/autopilot/app.pem", owners: ["me"], installations: ["me"], docker: "rootless" as const, poll_interval_seconds: 60 };
  assert.deepEqual(remoteHostFile(laptop), { ...laptop, private_key_path: "/run/credentials/autopilot.service/app-key" });
});
