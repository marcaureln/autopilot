export const TRIGGER_LABEL = "autopilot";

const STATES = {
  working: { color: "0e8a16", description: "autopilot: spec, build, checks or fix loop in progress" },
  "needs-info": { color: "fbca04", description: "autopilot: answer the questions in a comment" },
  "awaiting-approval": { color: "d93f0b", description: "autopilot: tick Approve and build in the spec" },
  blocked: { color: "b60205", description: "autopilot: stopped, see the last comment" },
} as const;

export type State = keyof typeof STATES;

export const LABELS = [
  { name: TRIGGER_LABEL, color: "000000", description: "autopilot: build this issue" },
  ...Object.entries(STATES).map(([state, label]) => ({ name: `${TRIGGER_LABEL}:${state}`, ...label })),
];
export type IssueState = State | "new";

const TRANSITIONS = {
  new: { start: "working" },
  working: { needs_info: "needs-info", approval_required: "awaiting-approval", fail: "blocked" },
  "needs-info": { reply: "working" },
  "awaiting-approval": { approve: "working" },
  blocked: {},
} as const satisfies Record<IssueState, Partial<Record<string, State>>>;

export type Event = { [S in IssueState]: keyof (typeof TRANSITIONS)[S] }[IssueState];

const LEGACY: Record<string, State> = {
  spec: "working",
  building: "working",
  checking: "working",
  "needs-review": "working",
};

export function stateLabel(state: State): string {
  return `${TRIGGER_LABEL}:${state}`;
}

function isState(name: string): name is State {
  return Object.hasOwn(STATES, name);
}

function suffix(label: string): string {
  return label.startsWith(`${TRIGGER_LABEL}:`) ? label.slice(TRIGGER_LABEL.length + 1) : "";
}

function stateOfLabel(label: string): State | undefined {
  const name = suffix(label);
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

// A closed issue has no job left, so it keeps none of the autopilot labels.
export function doneLabels(labels: string[]): string[] {
  return labels.filter((label) => label !== TRIGGER_LABEL && !label.startsWith(`${TRIGGER_LABEL}:`));
}

export function migrateLabels(labels: string[]): string[] | undefined {
  if (!labels.some((label) => Object.hasOwn(LEGACY, suffix(label)))) return undefined;
  const mapped = labels.map((label) => {
    const state = LEGACY[suffix(label)];
    return state ? stateLabel(state) : label;
  });
  return [...new Set(mapped)];
}
