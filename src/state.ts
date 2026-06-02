/**
 * Pi-agent session lifecycle — the state machine from NE-TSD-RT-V1 §2.2.
 *
 * The supervisor drives a run through these states; the harness asserts on which
 * terminal state a fixture reaches. Illegal transitions throw loudly so a bug in
 * the loop can never silently put a run in an impossible state.
 */

export type State =
  | "LOADING"
  | "REJECTED"
  | "ASSEMBLING"
  | "PLANNING"
  | "EXECUTING"
  | "AWAITING_APPROVAL"
  | "VERIFYING"
  | "REPLANNING"
  | "DONE"
  | "FAILED"
  | "ESCALATED";

export const TERMINAL: ReadonlySet<State> = new Set<State>([
  "DONE",
  "FAILED",
  "ESCALATED",
  "REJECTED",
]);

const TRANSITIONS: Record<State, State[]> = {
  LOADING: ["REJECTED", "ASSEMBLING"],
  ASSEMBLING: ["PLANNING"],
  PLANNING: ["EXECUTING"],
  EXECUTING: ["AWAITING_APPROVAL", "VERIFYING"],
  AWAITING_APPROVAL: ["EXECUTING", "FAILED"],
  VERIFYING: ["EXECUTING", "REPLANNING", "DONE"],
  REPLANNING: ["PLANNING", "ESCALATED"],
  REJECTED: [],
  DONE: [],
  FAILED: [],
  ESCALATED: [],
};

export class IllegalTransition extends Error {}

export function assertTransition(src: State, dst: State): void {
  if (!TRANSITIONS[src].includes(dst)) {
    throw new IllegalTransition(`illegal state transition ${src} -> ${dst}`);
  }
}
