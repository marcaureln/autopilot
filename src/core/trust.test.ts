import { test } from "node:test";
import assert from "node:assert/strict";
import type { Comment } from "./spec.ts";
import { isOwnerTick, isVouched, trustedGate, trustedThread, type Change, type CommentEdit } from "./trust.ts";

const OWNERS = ["marcaureln"];
const BOT = "autopilot[bot]";
const LABELED_AT = "2026-11-15T10:05:00Z";

const spec = "<!-- autopilot:spec gate=approval_required -->\n## Goal\nx\n\n- [ ] Approve and build";
const ticked = spec.replace("- [ ]", "- [x]");

const ownerTickCases: { name: string; body: string; editors: string[]; expected: boolean }[] = [
  { name: "ticked by an owner", body: ticked, editors: ["marcaureln", "autopilot"], expected: true },
  { name: "unticked and ticked again by an owner", body: ticked, editors: ["marcaureln", "marcaureln", "autopilot"], expected: true },
  { name: "ticked by the bot", body: ticked, editors: ["autopilot", "autopilot"], expected: false },
  { name: "ticked by a non-owner", body: ticked, editors: ["stranger", "autopilot"], expected: false },
  { name: "ticked by a non-owner, then edited by an owner", body: ticked, editors: ["marcaureln", "stranger", "autopilot"], expected: false },
  { name: "ticked with no recorded edit", body: ticked, editors: [], expected: false },
  { name: "edited by an owner but not ticked", body: spec, editors: ["marcaureln", "autopilot"], expected: false },
];

for (const { name, body, editors, expected } of ownerTickCases) {
  test(`owner tick: ${name}`, () => {
    assert.equal(isOwnerTick(body, editors, OWNERS), expected);
  });
}

const gateCases: { name: string; editors: string[]; expected: ReturnType<typeof trustedGate> }[] = [
  { name: "never edited", editors: [], expected: "approval_required" },
  { name: "edited by an owner", editors: ["marcaureln", "autopilot"], expected: undefined },
  { name: "edited by the bot", editors: ["autopilot", "autopilot"], expected: undefined },
  { name: "edited by a non-owner", editors: ["stranger", "autopilot"], expected: undefined },
];

for (const { name, editors, expected } of gateCases) {
  test(`recorded gate: ${name}`, () => {
    assert.equal(trustedGate(spec, editors), expected);
  });
}

const vouchedCases: { name: string; changes: Change[]; expected: boolean }[] = [
  { name: "written by an owner", changes: [{ by: "marcaureln", at: "2026-11-15T10:00:00Z" }], expected: true },
  { name: "written by a non-owner before the label", changes: [{ by: "stranger", at: "2026-11-15T10:00:00Z" }], expected: true },
  { name: "edited by a non-owner after the label", changes: [{ by: "stranger", at: "2026-11-15T10:06:00Z" }], expected: false },
  { name: "edited by an owner after the label", changes: [{ by: "marcaureln", at: "2026-11-15T10:06:00Z" }], expected: true },
  { name: "edited at the second of the label", changes: [{ by: "stranger", at: LABELED_AT }], expected: true },
  { name: "deleted account after the label", changes: [{ by: undefined, at: "2026-11-15T10:06:00Z" }], expected: false },
  {
    name: "body fine, title renamed by a non-owner after the label",
    changes: [
      { by: "marcaureln", at: "2026-11-15T10:00:00Z" },
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
  const comments = [comment(1, "marcaureln"), comment(2, BOT), comment(3, "stranger"), comment(4, "marcaureln"), comment(5, BOT), comment(6, "marcaureln")];
  const lastEdits = new Map<number, CommentEdit>([
    [1, { edited: false }],
    [2, { edited: false }],
    [3, { edited: false }],
    [4, { edited: true, by: "stranger" }],
    [5, { edited: true, by: "marcaureln" }],
  ]);
  assert.deepEqual(
    trustedThread(comments, lastEdits, BOT, OWNERS).map((kept) => kept.id),
    [1, 2, 5],
  );
});
