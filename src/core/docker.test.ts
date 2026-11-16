import { test } from "node:test";
import assert from "node:assert/strict";
import { isClientEnvName } from "./docker.ts";

const cases: { name: string; expected: boolean }[] = [
  { name: "STRIPE_KEY", expected: false },
  { name: "DATABASE_URL", expected: false },
  { name: "DOCKER_HOST", expected: true },
  { name: "DOCKER_CONFIG", expected: true },
  { name: "BUILDX_CONFIG", expected: true },
  { name: "XDG_RUNTIME_DIR", expected: true },
  { name: "PATH", expected: true },
  { name: "HOME", expected: true },
  { name: "HTTPS_PROXY", expected: true },
  { name: "PATHS", expected: false },
];

for (const { name, expected } of cases) {
  test(`${name} ${expected ? "is" : "is not"} read by the docker client`, () => {
    assert.equal(isClientEnvName(name), expected);
  });
}
