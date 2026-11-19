import { test } from "node:test";
import assert from "node:assert/strict";
import { hostLayout, parseOS, type HostOS } from "./layout.ts";

const osCases: { value: string; expected: HostOS }[] = [
  { value: "Linux\n", expected: "linux" },
  { value: "Darwin", expected: "darwin" },
  { value: "linux", expected: "linux" },
  { value: "darwin", expected: "darwin" },
];

for (const { value, expected } of osCases) {
  test(`${JSON.stringify(value)} is the host OS ${expected}`, () => {
    assert.equal(parseOS(value), expected);
  });
}

for (const value of ["FreeBSD", "win32", "MINGW64_NT-10.0", ""]) {
  test(`${JSON.stringify(value)} is not a supported host OS`, () => {
    assert.throws(() => parseOS(value), /not a supported host OS/);
  });
}

const layoutCases: { os: HostOS; home: string; field: "hostFile" | "skillsDir" | "current" | "tools"; expected: string }[] = [
  { os: "linux", home: "/home/me", field: "hostFile", expected: "/etc/autopilot/host.json" },
  { os: "linux", home: "/home/me", field: "skillsDir", expected: "/etc/autopilot/skills" },
  { os: "linux", home: "/home/me", field: "current", expected: "/opt/autopilot" },
  { os: "linux", home: "/home/me", field: "tools", expected: "/opt/autopilot-tools" },
  { os: "darwin", home: "/Users/me", field: "hostFile", expected: "/Users/me/.autopilot/host.json" },
  { os: "darwin", home: "/Users/me", field: "skillsDir", expected: "/Users/me/.autopilot/skills" },
  { os: "darwin", home: "/Users/me", field: "current", expected: "/Users/me/.autopilot/current" },
  { os: "darwin", home: "/Users/me", field: "tools", expected: "/Users/me/.autopilot/tools" },
];

for (const { os, home, field, expected } of layoutCases) {
  test(`${os}: ${field} is ${expected}`, () => {
    assert.equal(hostLayout(os, home)[field], expected);
  });
}

test("a release lives next to the others, one directory per tag or commit", () => {
  assert.equal(hostLayout("linux", "/home/me").release("v1.2.3"), "/opt/autopilot-v1.2.3");
  assert.equal(hostLayout("darwin", "/Users/me").release("0123456789ab"), "/Users/me/.autopilot/releases/0123456789ab");
});

test("Linux logs go to journald, macOS logs to files the user can read", () => {
  assert.deepEqual(hostLayout("linux", "/home/me").logs, { kind: "journal" });
  assert.deepEqual(hostLayout("darwin", "/Users/me").logs, {
    kind: "files",
    service: "/Users/me/Library/Logs/autopilot/autopilot.log",
    audit: "/Users/me/Library/Logs/autopilot/audit.log",
  });
});

test("only Linux needs sudo, and not for root", () => {
  assert.equal(hostLayout("linux", "/home/me").sudo(1000), "sudo ");
  assert.equal(hostLayout("linux", "/root").sudo(0), "");
  assert.equal(hostLayout("darwin", "/Users/me").sudo(501), "");
});
