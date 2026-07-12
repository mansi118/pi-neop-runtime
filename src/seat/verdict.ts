/**
 * Seat verdict endpoint — `POST /seat/verdict`, the in-VPC persistence hop for a Decision-Queue
 * approve/reject (the human-verdict fidelity signal). The bridge (nc_channels, out-of-VPC, NO palace
 * access) detects `m.neop.verdict` and forwards it here; this seat — which DOES have the env-baked
 * palace client — appends an authoritative human-verdict run-event to the INTERIM run_events store
 * (Mempalace #31), where the fidelity runner folds it into `human_only` fidelity.
 *
 * SECURITY: scope is env-baked by the PalaceClient (palaceId/neopId), NEVER from the payload — the
 * write lands under THIS seat's neopId. A `seat` in the body is only a mis-route guard: if present it
 * MUST equal this seat, else the verdict is rejected (it belongs to another seat's wrapper). Mirrors
 * `human_verdict_event` in the Python runtime (runtime/shadow.py) 1:1 so both writers agree on shape.
 * PURE over an injected sink (`recordVerdict`); auth is done by the transport (serveTurn) before this.
 */

export interface VerdictSink {
  recordVerdict?(event: Record<string, unknown>): Promise<void>;
}

/** The storable human-verdict event — identical shape to runtime.shadow.human_verdict_event. */
export function humanVerdictEvent(
  verdict: unknown,
  opts: { field?: string; kind?: string; decisionClass?: string; proposalId?: string | null } = {},
): Record<string, unknown> {
  const agreed = verdict === true || verdict === "approve";
  return {
    kind: "human_verdict",
    agreed,
    field: opts.field ?? "decision_style",
    signal_kind: opts.kind ?? "structural", // not the top-level `kind` discriminator
    decision_class: opts.decisionClass ?? "selective",
    proposal_id: opts.proposalId ?? null,
  };
}

export type VerdictParse =
  | { ok: true; verdict: "approve" | "reject"; seat?: string; proposalId?: string; by?: string }
  | { ok: false; errcode: string; error: string };

export function parseVerdict(rawBody: string): VerdictParse {
  let o: any;
  try {
    o = JSON.parse(rawBody || "{}");
  } catch {
    return { ok: false, errcode: "M_NOT_JSON", error: "body is not JSON" };
  }
  if (o === null || typeof o !== "object" || Array.isArray(o)) {
    return { ok: false, errcode: "M_BAD_JSON", error: "body must be a JSON object" };
  }
  if (o.verdict !== "approve" && o.verdict !== "reject") {
    return { ok: false, errcode: "M_BAD_VERDICT", error: "verdict must be 'approve' or 'reject'" };
  }
  const propId = typeof o.proposalId === "string" ? o.proposalId
    : typeof o.proposal_id === "string" ? o.proposal_id : undefined;
  return {
    ok: true,
    verdict: o.verdict,
    seat: typeof o.seat === "string" ? o.seat : undefined,
    proposalId: propId,
    by: typeof o.by === "string" ? o.by : undefined,
  };
}

/** Build the pure verdict handler (parse → mis-route guard → persist). Auth is the transport's job. */
export function makeVerdictHandler(opts: { memory: VerdictSink; neopId: string }) {
  return async (rawBody: string): Promise<{ status: number; body: unknown }> => {
    const p = parseVerdict(rawBody);
    if (!p.ok) return { status: 400, body: { errcode: p.errcode, error: p.error } };
    // Mis-route guard: scope is this seat's (env-baked). A verdict tagged for another seat is not ours.
    if (p.seat && p.seat !== opts.neopId) {
      return {
        status: 409,
        body: { errcode: "M_SEAT_MISMATCH", error: `verdict seat '${p.seat}' != this seat '${opts.neopId}' (mis-routed)` },
      };
    }
    if (!opts.memory.recordVerdict) {
      return { status: 500, body: { errcode: "M_NO_SINK", error: "this seat has no verdict sink (not live)" } };
    }
    try {
      await opts.memory.recordVerdict(humanVerdictEvent(p.verdict, { proposalId: p.proposalId ?? null }));
      return { status: 200, body: { status: "ok" } };
    } catch {
      // never leak internals; the bridge retries at-least-once, so a transient palace error is safe to surface as 500
      return { status: 500, body: { errcode: "M_UNKNOWN", error: "failed to persist the verdict" } };
    }
  };
}
