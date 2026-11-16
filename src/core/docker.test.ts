import { test } from "node:test";
import assert from "node:assert/strict";
import { clientEnv } from "./docker.ts";

const cases: { name: string; env: NodeJS.ProcessEnv; expected: NodeJS.ProcessEnv }[] = [
  { name: "keeps what docker needs", env: { PATH: "/bin", HOME: "/h", DOCKER_HOST: "unix:///run/d.sock", XDG_RUNTIME_DIR: "/run/u" }, expected: { PATH: "/bin", HOME: "/h", DOCKER_HOST: "unix:///run/d.sock", XDG_RUNTIME_DIR: "/run/u" } },
  { name: "drops the rest", env: { PATH: "/bin", OP_SERVICE_ACCOUNT_TOKEN: "x", CLAUDE_CODE_OAUTH_TOKEN: "y", CREDENTIALS_DIRECTORY: "/c" }, expected: { PATH: "/bin" } },
  { name: "drops unset names", env: { PATH: undefined }, expected: {} },
];

for (const { name, env, expected } of cases) {
  test(`docker client env: ${name}`, () => {
    assert.deepEqual(clientEnv(env), expected);
  });
}
