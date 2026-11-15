import { test } from "node:test";
import assert from "node:assert/strict";
import { claimComment, claimOf, ownClaims, type Claim } from "./claim.ts";
import type { Comment } from "./spec.ts";

const BOT = "autopilot[bot]";

function comment(id: number, createdAt: string, body: string, author = BOT): Comment {
  return { id, nodeId: `n${id}`, author, body, createdAt };
}

const claimBy = (id: number, createdAt: string, host: string, author = BOT) => comment(id, createdAt, claimComment(host), author);

const cases: { name: string; comments: Comment[]; expected: Claim }[] = [
  { name: "no claim", comments: [comment(1, "2026-11-15T10:00:00Z", "a question", "me")], expected: { kind: "free" } },
  { name: "own claim", comments: [claimBy(2, "2026-11-15T10:00:00Z", "pi")], expected: { kind: "mine" } },
  {
    name: "another host claimed first",
    comments: [claimBy(2, "2026-11-15T10:00:00Z", "mac"), claimBy(3, "2026-11-15T10:00:05Z", "pi")],
    expected: { kind: "theirs", host: "mac" },
  },
  {
    name: "another host claimed later",
    comments: [claimBy(2, "2026-11-15T10:00:00Z", "pi"), claimBy(3, "2026-11-15T10:00:05Z", "mac")],
    expected: { kind: "mine" },
  },
  {
    name: "two claims in the same second are ordered by comment id",
    comments: [claimBy(9, "2026-11-15T10:00:00Z", "pi"), claimBy(8, "2026-11-15T10:00:00Z", "mac")],
    expected: { kind: "theirs", host: "mac" },
  },
  {
    name: "a claim marker from someone else than the bot does not count",
    comments: [claimBy(2, "2026-11-15T10:00:00Z", "mac", "stranger"), claimBy(3, "2026-11-15T10:00:05Z", "pi")],
    expected: { kind: "mine" },
  },
  {
    name: "a marker that is not at the start of the comment does not count",
    comments: [comment(2, "2026-11-15T10:00:00Z", `quoted:\n${claimComment("mac")}`), claimBy(3, "2026-11-15T10:00:05Z", "pi")],
    expected: { kind: "mine" },
  },
];

for (const { name, comments, expected } of cases) {
  test(`claim for host pi: ${name}`, () => {
    assert.deepEqual(claimOf(comments, BOT, "pi"), expected);
  });
}

test("a host that loses a race finds its own claim comments to delete", () => {
  const comments = [claimBy(2, "2026-11-15T10:00:00Z", "mac"), claimBy(3, "2026-11-15T10:00:00Z", "pi"), claimBy(4, "2026-11-15T10:00:00Z", "pi", "stranger")];
  assert.deepEqual(
    ownClaims(comments, BOT, "pi").map((claim) => claim.id),
    [3],
  );
});
