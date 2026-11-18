import { test } from "node:test";
import assert from "node:assert/strict";
import { configDirOf } from "./config-dir.ts";

const cases: { name: string; xdg: string | undefined; expected: string }[] = [
  { name: "no XDG_CONFIG_HOME", xdg: undefined, expected: "/home/me/.config/autopilot" },
  { name: "an empty XDG_CONFIG_HOME", xdg: "", expected: "/home/me/.config/autopilot" },
  { name: "an absolute XDG_CONFIG_HOME", xdg: "/srv/config", expected: "/srv/config/autopilot" },
  { name: "a relative XDG_CONFIG_HOME", xdg: "config", expected: "/home/me/.config/autopilot" },
];

for (const { name, xdg, expected } of cases) {
  test(`config dir: ${name}`, () => {
    assert.equal(configDirOf(xdg, "/home/me"), expected);
  });
}
