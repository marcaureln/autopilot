import type { Gate1 } from "./gate.ts";
import { isApproved, specGate, type Comment } from "./spec.ts";

// Text that reaches the planner, or that moves an issue, must come from an owner. Write access lets
// other people edit issues and comments, including the bot's, so the edit history decides.

export type Change = { by: string | undefined; at: string };

// `by` is undefined when the editor deleted their account.
export type CommentEdit = { edited: false } | { edited: true; by: string | undefined };

// The edits of a comment, newest first. Once a comment is edited, GitHub also lists its original
// text as the oldest entry, by the author.
function realEdits(editors: string[]): string[] {
  return editors.slice(0, -1);
}

// GitHub has no record of who ticked a box, only of who edited the comment.
export function isOwnerTick(body: string, editors: string[], owners: string[]): boolean {
  const edits = realEdits(editors);
  return isApproved(body) && edits.length > 0 && edits.every((editor) => owners.includes(editor));
}

// autopilot never edits its spec comments, so an edited one can carry a changed gate.
export function trustedGate(body: string, editors: string[]): Gate1["event"] | undefined {
  return editors.length === 0 ? specGate(body) : undefined;
}

// An owner vouches for the text that existed when they added the label, and for their own later edits.
export function isVouched(changes: Change[], owners: string[], labeledAt: string): boolean {
  return changes.every((change) => (change.by !== undefined && owners.includes(change.by)) || Date.parse(change.at) <= Date.parse(labeledAt));
}

export function trustedThread(comments: Comment[], lastEdits: Map<number, CommentEdit>, botLogin: string, owners: string[]): Comment[] {
  return comments.filter((comment) => {
    if (comment.author !== botLogin && !owners.includes(comment.author)) return false;
    const edit = lastEdits.get(comment.id);
    if (!edit) return false;
    return !edit.edited || (edit.by !== undefined && owners.includes(edit.by));
  });
}
