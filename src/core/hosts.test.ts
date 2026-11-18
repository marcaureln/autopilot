import { test } from "node:test";
import assert from "node:assert/strict";
import { addHost, nameOfTarget, NO_HOSTS, parseHosts, removeHost, resolveHost, setDefaultHost, type HostRef, type HostsFile } from "./hosts.ts";

const FILE: HostsFile = { default: "pi", hosts: { pi: { target: "rpi" }, mac: { target: "local" } } };

const parses: { name: string; text: string; error?: RegExp }[] = [
  { name: "a file with a default", text: JSON.stringify(FILE) },
  { name: "a file with no host", text: `{ "hosts": {} }` },
  { name: "text that is not JSON", text: `{ "hosts": `, error: /Invalid hosts file hosts\.json: .*JSON/ },
  { name: "a file with no hosts", text: `{ "default": "pi" }`, error: /must have required property 'hosts'/ },
  { name: "a default that is not a host", text: `{ "default": "nas", "hosts": { "pi": { "target": "rpi" } } }`, error: /the default "nas" is not one of its hosts/ },
  { name: "a host named local", text: `{ "hosts": { "local": { "target": "rpi" } } }`, error: /hosts\.json: "local" is not a host name/ },
  { name: "a target that is an ssh option", text: `{ "hosts": { "pi": { "target": "-oProxyCommand=x" } } }`, error: /target/ },
  { name: "a host with an unknown field", text: `{ "hosts": { "pi": { "target": "rpi", "token": "x" } } }`, error: /additional properties/ },
];

for (const { name, text, error } of parses) {
  test(`hosts file: ${error ? "rejects" : "reads"} ${name}`, () => {
    if (error) assert.throws(() => parseHosts(text, "hosts.json"), error);
    else assert.deepEqual(parseHosts(text, "hosts.json"), JSON.parse(text));
  });
}

const repairs: { name: string; text: string; expected: HostsFile | RegExp }[] = [
  { name: "drops a default that is not a host", text: `{ "default": "nas", "hosts": { "pi": { "target": "rpi" } } }`, expected: { default: undefined, hosts: { pi: { target: "rpi" } } } },
  { name: "keeps a default that is a host", text: JSON.stringify(FILE), expected: FILE },
  { name: "still rejects text that is not JSON", text: `{ "hosts": `, expected: /Invalid hosts file hosts\.json/ },
  { name: "still rejects a host named local", text: `{ "hosts": { "local": { "target": "rpi" } } }`, expected: /"local" is not a host name/ },
];

for (const { name, text, expected } of repairs) {
  test(`hosts file for edit: ${name}`, () => {
    if (expected instanceof RegExp) assert.throws(() => parseHosts(text, "hosts.json", true), expected);
    else assert.deepEqual(parseHosts(text, "hosts.json", true), expected);
  });
}

const resolutions: { name: string; file: HostsFile; flag?: string; env?: string; expected: HostRef | undefined }[] = [
  { name: "--host wins over AUTOPILOT_HOST and the default", file: FILE, flag: "mac", env: "pi", expected: { savedName: "mac", target: "local" } },
  { name: "AUTOPILOT_HOST wins over the default", file: FILE, env: "mac", expected: { savedName: "mac", target: "local" } },
  { name: "the default comes last", file: FILE, expected: { savedName: "pi", target: "rpi" } },
  { name: "no value and no default is no host", file: NO_HOSTS, expected: undefined },
  { name: "a value that is not a name is an SSH target", file: FILE, flag: "me@nas", expected: { target: "me@nas" } },
  { name: "local that is not a name is this machine", file: NO_HOSTS, env: "local", expected: { target: "local" } },
  { name: "an empty --host runs here despite the default", file: FILE, flag: "", env: "mac", expected: undefined },
  { name: "an empty AUTOPILOT_HOST runs here despite the default", file: FILE, env: "", expected: undefined },
  { name: "a name of Object.prototype is an SSH target", file: FILE, flag: "constructor", expected: { target: "constructor" } },
];

for (const { name, file, flag, env, expected } of resolutions) {
  test(`host resolution: ${name}`, () => {
    assert.deepEqual(resolveHost(flag, env, () => file), expected);
  });
}

test("host resolution: refuses a value that ssh would read as an option", () => {
  assert.throws(() => resolveHost("-oProxyCommand=x", undefined, () => NO_HOSTS), /not a host of the hosts file or an SSH target/);
});

test("host resolution: an empty value does not read the hosts file", () => {
  const broken = () => assert.fail("read the hosts file");
  assert.equal(resolveHost("", "pi", broken), undefined);
  assert.equal(resolveHost(undefined, "", broken), undefined);
});

const names: { file: HostsFile; target: string; expected: string }[] = [
  { file: NO_HOSTS, target: "rpi", expected: "rpi" },
  { file: NO_HOSTS, target: "pi@raspberrypi.lan", expected: "raspberrypi.lan" },
  { file: NO_HOSTS, target: "ssh://pi@rpi:2222", expected: "rpi" },
  { file: NO_HOSTS, target: "local", expected: "my-mac" },
  { file: FILE, target: "rpi", expected: "pi" },
  { file: FILE, target: "local", expected: "mac" },
];

for (const { file, target, expected } of names) {
  test(`setup names the target ${target} ${expected} with ${Object.keys(file.hosts).length} hosts in the file`, () => {
    assert.equal(nameOfTarget(file, target, "my-mac"), expected);
  });
}

const changes: { name: string; change: () => HostsFile; expected: HostsFile }[] = [
  { name: "the first host added becomes the default", change: () => addHost(NO_HOSTS, "pi", "rpi"), expected: { default: "pi", hosts: { pi: { target: "rpi" } } } },
  {
    name: "a later host keeps the default",
    change: () => addHost(FILE, "nas", "me@nas"),
    expected: { default: "pi", hosts: { pi: { target: "rpi" }, mac: { target: "local" }, nas: { target: "me@nas" } } },
  },
  { name: "adding a name again changes its target", change: () => addHost(FILE, "pi", "pi@10.0.0.5"), expected: { default: "pi", hosts: { pi: { target: "pi@10.0.0.5" }, mac: { target: "local" } } } },
  { name: "removing the default leaves no default", change: () => removeHost(FILE, "pi"), expected: { default: undefined, hosts: { mac: { target: "local" } } } },
  { name: "removing another host keeps the default", change: () => removeHost(FILE, "mac"), expected: { default: "pi", hosts: { pi: { target: "rpi" } } } },
  { name: "default sets the default", change: () => setDefaultHost(FILE, "mac"), expected: { default: "mac", hosts: FILE.hosts } },
];

for (const { name, change, expected } of changes) {
  test(`hosts file: ${name}`, () => {
    assert.deepEqual(change(), expected);
  });
}

const refusals: { name: string; change: () => HostsFile; error: RegExp }[] = [
  { name: "add a host named local", change: () => addHost(NO_HOSTS, "local", "rpi"), error: /"local" is not a host name/ },
  { name: "add a name with a space", change: () => addHost(NO_HOSTS, "my pi", "rpi"), error: /"my pi" is not a host name/ },
  { name: "add a target that ssh reads as an option", change: () => addHost(NO_HOSTS, "pi", "-oProxyCommand=x"), error: /is not an SSH target/ },
  { name: "remove an unknown host", change: () => removeHost(FILE, "nas"), error: /no host named nas/ },
  { name: "make an unknown host the default", change: () => setDefaultHost(FILE, "nas"), error: /no host named nas/ },
];

for (const { name, change, error } of refusals) {
  test(`hosts file: refuses to ${name}`, () => {
    assert.throws(change, error);
  });
}
