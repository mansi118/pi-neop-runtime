/**
 * Live seat-serve entrypoint (M1b mechanism) — the Hermes analog of the jcode adapter's
 * `supervisor._spawn`. Runs a NEop on a REAL task through the canonical `dispatch()` in "live" mode.
 *
 * The supervisor's "live" mode already wires everything: the provider-aware model broker (D2 —
 * OpenRouter primary, `model.ts`), the GAP-1 `PalaceClient` memory broker (live CORTEX-PALACE), the
 * live tool broker (allowlist + `beforeToolCall` guard), and ACP. This module only turns a real task
 * into the run-case the supervisor consumes, then drives it. Thin by design.
 *
 * BOX-GATED + STOP-AND-ASK. Actually running a real NEop is T9 ("first real NEop" — CLAUDE.md says
 * STOP-and-ask). It needs: the box (the GAP-2 egress jail), a live palace (PALACE_MCP_URL/PALACE_ID/
 * NEOP_ID — GAP-1), and a model key (OPENROUTER_API_KEY per D2). `buildRunCase` + the provider logic are
 * unit-tested; the live run is not — it proves out only on the box, after GAP-1 ∧ GAP-2 are green.
 */

import { dispatch } from "./api.ts";
import type { RunResult } from "./supervisor.ts";
import type { Mode } from "./brokers/model.ts";

export interface SeatTask {
  task: string; // the real objective text the NEop is asked to do
  caseId?: string; // defaults to a stamped live id
  stm?: unknown[]; // optional short-term context to seed the run
  seedTwin?: string; // optional twin preamble
  approvals?: "grant" | "deny"; // side-effecting tools pause for approval (Policy v1); default grant
}

/** Synthesize the run-case the SessionSupervisor consumes from a real task. Pure + unit-tested. */
export function buildRunCase(t: SeatTask, now: number): any {
  if (!t.task || !t.task.trim()) {
    throw new Error("seat task is empty — refusing to run a NEop with no objective");
  }
  return {
    case_id: t.caseId ?? `live-${now}`,
    input: { text: t.task.trim() },
    stm: t.stm ?? [],
    seed_twin: t.seedTwin,
    approvals: t.approvals ?? "grant",
  };
}

/**
 * Run a NEop on a real task. mode defaults to "live" (the real point of this entrypoint); "unit"/
 * "integration" are accepted for harness reuse. Returns the canonical RunResult (terminal state +
 * outcomes + trace). The live run itself is box-gated (see file header).
 */
export async function serveSeat(
  neopPath: string,
  t: SeatTask,
  mode: Mode = "live",
  now = 0,
): Promise<RunResult> {
  return dispatch(neopPath, buildRunCase(t, now), mode);
}
