import { test } from "node:test";
import assert from "node:assert/strict";
import type { Comment } from "./spec.ts";
import { isOwnerTick, isVouched, trustedSpec, trustedThread, type Change, type CommentEdit } from "./trust.ts";

const OWNERS = ["owner"];
const BOT = "autopilot[bot]";
const LABELED_AT = "2026-11-15T10:05:00Z";

const spec = "<!-- autopilot:spec gate=approval_required planner=low -->\n## Goal\nx\n\n- [ ] Approve and build";
const ticked = spec.replace("- [ ]", "- [x]");

const ownerTickCases: { name: string; body: string; editors: string[]; expected: boolean }[] = [
  { name: "ticked by an owner", body: ticked, editors: ["owner", "autopilot"], expected: true },
  { name: "unticked and ticked again by an owner", body: ticked, editors: ["owner", "owner", "autopilot"], expected: true },
  { name: "ticked by the bot", body: ticked, editors: ["autopilot", "autopilot"], expected: false },
  { name: "ticked by a non-owner", body: ticked, editors: ["stranger", "autopilot"], expected: false },
  { name: "ticked by a non-owner, then edited by an owner", body: ticked, editors: ["owner", "stranger", "autopilot"], expected: false },
  { name: "ticked with no recorded edit", body: ticked, editors: [], expected: false },
  { name: "edited by an owner but not ticked", body: spec, editors: ["owner", "autopilot"], expected: false },
];

for (const { name, body, editors, expected } of ownerTickCases) {
  test(`owner tick: ${name}`, () => {
    assert.equal(isOwnerTick(body, editors, OWNERS), expected);
  });
}

const go = "<!-- autopilot:spec gate=go planner=low -->\n## Goal\nx";

const specCases: { name: string; body: string; editors: string[]; expected: ReturnType<typeof trustedSpec> }[] = [
  { name: "go, never edited", body: go, editors: [], expected: { gate: "go", plannerRisk: "low", buildAllowed: true } },
  { name: "approval, never edited", body: spec, editors: [], expected: { gate: "approval_required", plannerRisk: "low", buildAllowed: false } },
  { name: "approval, ticked by an owner", body: ticked, editors: ["owner", "autopilot"], expected: { gate: "approval_required", plannerRisk: "low", buildAllowed: true } },
  { name: "approval, ticked by a non-owner", body: ticked, editors: ["stranger", "autopilot"], expected: undefined },
  { name: "approval, edited by an owner but not ticked", body: spec, editors: ["owner", "autopilot"], expected: undefined },
  { name: "go, edited by an owner", body: go, editors: ["owner", "autopilot"], expected: undefined },
  { name: "go, edited by the bot", body: go, editors: ["autopilot", "autopilot"], expected: undefined },
  { name: "a go marker in a ticked comment", body: `${go}\n\n- [x] Approve and build`, editors: ["owner", "autopilot"], expected: undefined },
  { name: "not a spec", body: "Looks good", editors: [], expected: undefined },
  { name: "a spec from before Gate 2", body: "<!-- autopilot:spec gate=go -->\nx", editors: [], expected: { gate: "go", plannerRisk: undefined, buildAllowed: true } },
];

for (const { name, body, editors, expected } of specCases) {
  test(`trusted spec: ${name}`, () => {
    assert.deepEqual(trustedSpec(body, editors, OWNERS), expected);
  });
}

const vouchedCases: { name: string; changes: Change[]; expected: boolean }[] = [
  { name: "written by an owner", changes: [{ by: "owner", at: "2026-11-15T10:00:00Z" }], expected: true },
  { name: "written by a non-owner before the label", changes: [{ by: "stranger", at: "2026-11-15T10:00:00Z" }], expected: true },
  { name: "edited by a non-owner after the label", changes: [{ by: "stranger", at: "2026-11-15T10:06:00Z" }], expected: false },
  { name: "edited by an owner after the label", changes: [{ by: "owner", at: "2026-11-15T10:06:00Z" }], expected: true },
  { name: "edited at the second of the label", changes: [{ by: "stranger", at: LABELED_AT }], expected: true },
  { name: "deleted account after the label", changes: [{ by: undefined, at: "2026-11-15T10:06:00Z" }], expected: false },
  {
    name: "body fine, title renamed by a non-owner after the label",
    changes: [
      { by: "owner", at: "2026-11-15T10:00:00Z" },
      { by: "stranger", at: "2026-11-15T10:07:00Z" },
    ],
    expected: false,
  },
];

for (const { name, changes, expected } of vouchedCases) {
  test(`issue text: ${name}`, () => {
    assert.equal(isVouched(changes, OWNERS, LABELED_AT), expected);
  });
}

function comment(id: number, author: string): Comment {
  return { id, nodeId: `C${id}`, author, body: `comment ${id}`, createdAt: "2026-11-15T10:10:00Z" };
}

test("the planner thread keeps only owner and bot comments that no one else edited", () => {
  const comments = [comment(1, "owner"), comment(2, BOT), comment(3, "stranger"), comment(4, "owner"), comment(5, BOT), comment(6, "owner")];
  const lastEdits = new Map<number, CommentEdit>([
    [1, { edited: false }],
    [2, { edited: false }],
    [3, { edited: false }],
    [4, { edited: true, by: "stranger" }],
    [5, { edited: true, by: "owner" }],
  ]);
  assert.deepEqual(
    trustedThread(comments, lastEdits, BOT, OWNERS).map((kept) => kept.id),
    [1, 2, 5],
  );
});
