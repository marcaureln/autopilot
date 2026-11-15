import { test } from "node:test";
import assert from "node:assert/strict";
import { nodeInstallCommand, planChecks } from "./checks.ts";

test("each required check gets a stack command, a built-in scanner, or nothing", () => {
  assert.deepEqual(planChecks(["lint", "sast", "deps-scan", "secrets-scan", "types"], { lint: "npm run lint", sast: "make sast" }), [
    { check: "lint", kind: "stack", command: "npm run lint" },
    { check: "sast", kind: "stack", command: "make sast" },
    { check: "deps-scan", kind: "scanner", scanner: "deps-scan" },
    { check: "secrets-scan", kind: "scanner", scanner: "secrets-scan" },
    { check: "types", kind: "missing" },
  ]);
});

const installCases: { files: string[]; expected: string | undefined }[] = [
  { files: ["package.json", "package-lock.json"], expected: "npm ci" },
  { files: ["package.json", "pnpm-lock.yaml"], expected: "npm install --global pnpm && pnpm install --frozen-lockfile" },
  { files: ["package.json", "yarn.lock"], expected: "npm install --global yarn && yarn install --frozen-lockfile" },
  { files: ["package.json"], expected: "npm install" },
  { files: ["README.md"], expected: undefined },
];

for (const { files, expected } of installCases) {
  test(`install for [${files.join(", ")}]`, () => {
    assert.equal(nodeInstallCommand((file) => files.includes(file)), expected);
  });
}
