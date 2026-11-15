import type { Comment } from "./spec.ts";

const MARKER = /^<!-- autopilot:claim host=([a-z0-9-]+) -->/;

export type Claim = { kind: "free" } | { kind: "mine" } | { kind: "theirs"; host: string };

export function claimComment(host: string): string {
  return `<!-- autopilot:claim host=${host} -->\nautopilot host \`${host}\` works on this issue.`;
}

function claims(comments: Comment[], botLogin: string): { comment: Comment; host: string }[] {
  return comments
    .flatMap((comment) => {
      const host = comment.author === botLogin ? MARKER.exec(comment.body)?.[1] : undefined;
      return host ? [{ comment, host }] : [];
    })
    .sort((a, b) => Date.parse(a.comment.createdAt) - Date.parse(b.comment.createdAt) || a.comment.id - b.comment.id);
}

export function claimOf(comments: Comment[], botLogin: string, me: string): Claim {
  const oldest = claims(comments, botLogin)[0];
  if (!oldest) return { kind: "free" };
  return oldest.host === me ? { kind: "mine" } : { kind: "theirs", host: oldest.host };
}

export function ownClaims(comments: Comment[], botLogin: string, me: string): Comment[] {
  return claims(comments, botLogin)
    .filter((claim) => claim.host === me)
    .map((claim) => claim.comment);
}
