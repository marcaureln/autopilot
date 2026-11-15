import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { shellQuote, urlToOpen } from "./client.ts";

for (const arg of ["audit", "--since", "1 day ago", "it's", "$(id)", "a'b'c", ""]) {
  test(`the remote shell reads ${JSON.stringify(arg)} back unchanged`, () => {
    assert.equal(execFileSync("sh", ["-c", `printf %s ${shellQuote(arg)}`], { encoding: "utf8" }), arg);
  });
}

const INSTALL = "https://github.com/apps/me-autopilot/installations/new/permissions?target_id=42";

const openCases: { command: string; line: string; expected: string | undefined }[] = [
  { command: "allow", line: `open: ${INSTALL}`, expected: INSTALL },
  { command: "logs", line: `open: ${INSTALL}`, expected: undefined },
  { command: "audit", line: `open: ${INSTALL}`, expected: undefined },
  { command: "allow", line: "open: https://github.com/apps/me-autopilot", expected: undefined },
  { command: "allow", line: "open: https://github.com/login/oauth/authorize?client_id=x", expected: undefined },
  { command: "allow", line: `open: ${INSTALL}&redirect=https://evil.example`, expected: undefined },
  { command: "allow", line: "open: https://github.com/apps/Me_App/installations/new/permissions?target_id=42", expected: undefined },
  { command: "allow", line: "open: https://evil.example/apps/x/installations/new/permissions?target_id=1", expected: undefined },
  { command: "allow", line: "open: http://github.com/apps/x/installations/new/permissions?target_id=1", expected: undefined },
  { command: "allow", line: `  open: ${INSTALL}`, expected: undefined },
  { command: "allow", line: "allowed me/app on pi", expected: undefined },
];

for (const { command, line, expected } of openCases) {
  test(`${command}: the client opens ${expected ? "the install page" : "nothing"} for "${line}"`, () => {
    assert.equal(urlToOpen(command, line), expected);
  });
}
