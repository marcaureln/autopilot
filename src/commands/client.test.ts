import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hostCommand, shellQuote, urlToOpen } from "./client.ts";

for (const arg of ["audit", "--since", "1 day ago", "it's", "$(id)", "a'b'c", ""]) {
  test(`the remote shell reads ${JSON.stringify(arg)} back unchanged`, () => {
    assert.equal(execFileSync("sh", ["-c", `printf %s ${shellQuote(arg)}`], { encoding: "utf8" }), arg);
  });
}

const INSTALL = "https://github.com/apps/me-autopilot/installations/new/permissions?target_id=42";

const openCases: { command: string; line: string; expected: string | undefined }[] = [
  { command: "watch", line: `open: ${INSTALL}`, expected: INSTALL },
  { command: "logs", line: `open: ${INSTALL}`, expected: undefined },
  { command: "audit", line: `open: ${INSTALL}`, expected: undefined },
  { command: "watch", line: "open: https://github.com/apps/me-autopilot", expected: undefined },
  { command: "watch", line: "open: https://github.com/login/oauth/authorize?client_id=x", expected: undefined },
  { command: "watch", line: `open: ${INSTALL}&redirect=https://evil.example`, expected: undefined },
  { command: "watch", line: "open: https://github.com/apps/Me_App/installations/new/permissions?target_id=42", expected: undefined },
  { command: "watch", line: "open: https://evil.example/apps/x/installations/new/permissions?target_id=1", expected: undefined },
  { command: "watch", line: "open: http://github.com/apps/x/installations/new/permissions?target_id=1", expected: undefined },
  { command: "watch", line: `  open: ${INSTALL}`, expected: undefined },
  { command: "watch", line: "pi watches me/app", expected: undefined },
];

for (const { command, line, expected } of openCases) {
  test(`${command}: the client opens ${expected ? "the install page" : "nothing"} for "${line}"`, () => {
    assert.equal(urlToOpen(command, line), expected);
  });
}

function fakeHost(uname: string): { env: NodeJS.ProcessEnv } {
  const home = mkdtempSync(join(tmpdir(), "autopilot-host-"));
  const bin = join(home, "fake-bin");
  mkdirSync(join(home, ".autopilot", "bin"), { recursive: true });
  mkdirSync(bin);
  const script = (path: string, body: string) => {
    writeFileSync(path, `#!/bin/sh\n${body}\n`);
    chmodSync(path, 0o755);
  };
  script(join(bin, "uname"), `echo ${uname}`);
  script(join(bin, "sudo"), 'echo sudo "$@"');
  script(join(home, ".autopilot", "bin", "autopilot"), 'echo home-command "$@"');
  return { env: { HOME: home, PATH: `${bin}:/usr/bin:/bin` } };
}

const hostCases: { uname: string; expected: string }[] = [
  { uname: "Linux", expected: "sudo autopilot logs --since 1 day ago\n" },
  { uname: "Darwin", expected: "home-command logs --since 1 day ago\n" },
];

for (const { uname, expected } of hostCases) {
  test(`a ${uname} host runs the forwarded command from its own place`, () => {
    assert.equal(execFileSync("sh", ["-c", hostCommand(["logs", "--since", "1 day ago"])], { encoding: "utf8", ...fakeHost(uname) }), expected);
  });
}
