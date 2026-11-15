export const TRIGGER_LABEL = "autopilot";

export const STATES = {
  spec: { color: "1d76db", description: "autopilot: the planner is writing a spec" },
  "needs-info": { color: "fbca04", description: "autopilot: answer the questions in a comment" },
  "awaiting-approval": { color: "d93f0b", description: "autopilot: tick Approve and build in the spec" },
  building: { color: "0e8a16", description: "autopilot: the builder is implementing" },
  checking: { color: "5319e7", description: "autopilot: checks are running" },
  "needs-review": { color: "d93f0b", description: "autopilot: review and merge the PR" },
  blocked: { color: "b60205", description: "autopilot: stopped, see the last comment" },
} as const;

export type State = keyof typeof STATES;
export type IssueState = State | "new";

const TRANSITIONS = {
  new: { start: "spec" },
  spec: { needs_info: "needs-info", approval_required: "awaiting-approval", go: "building", fail: "blocked" },
  "needs-info": { reply: "spec" },
  "awaiting-approval": { approve: "building" },
  building: {},
  checking: {},
  "needs-review": {},
  blocked: {},
} as const satisfies Record<IssueState, Partial<Record<string, State>>>;

export type Event = { [S in IssueState]: keyof (typeof TRANSITIONS)[S] }[IssueState];

export function stateLabel(state: State): string {
  return `${TRIGGER_LABEL}:${state}`;
}

function isState(name: string): name is State {
  return Object.hasOwn(STATES, name);
}

function stateOfLabel(label: string): State | undefined {
  const name = label.startsWith(`${TRIGGER_LABEL}:`) ? label.slice(TRIGGER_LABEL.length + 1) : "";
  return isState(name) ? name : undefined;
}

export function stateOf(labels: string[]): IssueState | "ambiguous" {
  const states = labels.map(stateOfLabel).filter((state) => state !== undefined);
  if (states.length > 1) return "ambiguous";
  return states[0] ?? "new";
}

export function transition(from: IssueState, event: Event): State | undefined {
  const next: Partial<Record<string, State>> = TRANSITIONS[from];
  return next[event];
}

export function labelsFor(labels: string[], state: State): string[] {
  return [...labels.filter((label) => stateOfLabel(label) === undefined), stateLabel(state)];
}
