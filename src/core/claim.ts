import { createHmac } from "node:crypto";
import type { Comment } from "./spec.ts";

const MARKER = /^<!-- autopilot:claim host=([a-z0-9-]+) -->/;

export type Claim = { kind: "free" } | { kind: "mine" } | { kind: "theirs"; host: string };

// Issues can be public, so a claim names its host by an id, not by its name. The App key keys the
// id: hosts of one App get different ids, and a reader cannot get the name back by guessing it.
export function claimId(hostName: string, appKey: string): string {
  return createHmac("sha256", appKey).update(hostName).digest("hex").slice(0, 12);
}

export function claimComment(id: string): string {
  return `<!-- autopilot:claim host=${id} -->\nautopilot works on this issue.`;
}

function claims(comments: Comment[], botLogin: string): { comment: Comment; host: string }[] {
  return comments
    .flatMap((comment) => {
      const host = comment.author === botLogin ? MARKER.exec(comment.body)?.[1] : undefined;
      return host ? [{ comment, host }] : [];
    })
    .sort((a, b) => Date.parse(a.comment.createdAt) - Date.parse(b.comment.createdAt) || a.comment.id - b.comment.id);
}

// `me` holds the ids of this host: its claim id, and its name, which older claims used.
export function claimOf(comments: Comment[], botLogin: string, me: string[]): Claim {
  const oldest = claims(comments, botLogin)[0];
  if (!oldest) return { kind: "free" };
  return me.includes(oldest.host) ? { kind: "mine" } : { kind: "theirs", host: oldest.host };
}

export function ownClaims(comments: Comment[], botLogin: string, me: string[]): Comment[] {
  return claims(comments, botLogin)
    .filter((claim) => me.includes(claim.host))
    .map((claim) => claim.comment);
}
