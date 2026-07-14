/**
 * Write-trigger (Track 3 keystone) — on a completed conversational turn, persist the run-events the
 * memory-intelligence loops read: a `shadow_prediction` for the fidelity clock and (when a real
 * extractor surfaces one) a `memory_candidate` for the vault promoter. This is the SEAT half of the
 * pattern the verdict endpoint (verdict.ts) established: the seat has the env-baked palace client, so
 * IT does the in-VPC run_events write; the loops (runtime/fidelity_runner.py, runtime/vault_runner.py)
 * fold what lands here.
 *
 * TWO EVENT KINDS, both stored via palace_put_run_event under the seat's OWN env-baked scope:
 *   - shadow_prediction — the NEop's predicted reply for THIS turn. `actual` is left null: an
 *     auto-responding dogfood NEop has no separate human "actual" per turn (the known signal-generation
 *     gap), so the pair is UNSCORED until a later human verdict / judge grades it. We record the
 *     prediction HONESTLY (never fabricate an `actual` or an `agreed`); the corpus warms so a judge or a
 *     retro human-actual can grade it. Shape mirrors core.py's shadow_prediction + runtime/shadow.py's
 *     is_shadow_event/signal_from_event 1:1.
 *   - memory_candidate — a durable fact worth promoting, shape-identical to runtime/vault.py's candidate
 *     contract (content · confidence · category · provenance{source_adapter,source_external_id,
 *     author_type,author_id} · dedup_key). We do NOT fabricate a confidence for every turn: the candidate
 *     comes from an INJECTED `extract` seam (default: none). A real extractor (the decision-shadow work)
 *     lands as the follow-up; this wires + tests the pipe without inventing a VL-1 confidence.
 *
 * POSTURE: BEST-EFFORT. The turn reply is the product; these events are telemetry. `onTurn` NEVER throws
 * and NEVER blocks the reply — a palace hiccup must not 500 the user or add latency to their answer. The
 * broker sink itself throws loud (a swallowed write is invisible), and this wrapper is what swallows, so
 * the failure is logged, not propagated. PURE over the injected sink + extractor — unit-tested, no network.
 */
import type { ReplyEnvelope } from "./reply.ts";
import type { TurnRequest } from "./wrapper.ts";

/** The slice of the memory broker the trigger writes through (both throw loud on a non-ok palace write). */
export interface TriggerSink {
  recordShadowPrediction?(event: Record<string, unknown>): Promise<void>;
  recordCandidate?(event: Record<string, unknown>): Promise<void>;
}

/** A durable-fact candidate the extractor surfaces from a turn — the fields vault.py's `promote` reads. */
export interface Candidate {
  content: unknown;
  confidence: number; // HONEST, from the extractor — VL-1 floors it; a fabricated value must not appear here
  category?: string;
  authorType?: string; // provenance.author_type (default "user")
  authorId?: string; // provenance.author_id
}

/** Decide whether a turn yields a memory candidate. Default is none — we never guess a confidence. May be
 * async (a model-backed extractor makes a generation call). Runs inside the best-effort trigger, so it
 * never blocks the reply and a throw/timeout is swallowed. */
export type CandidateExtractor = (
  req: TurnRequest,
  env: ReplyEnvelope,
) => Candidate | null | undefined | Promise<Candidate | null | undefined>;

export interface WriteTriggerOpts {
  sink: TriggerSink;
  neopId: string;
  /** Real extractor lands later (decision-shadow); default emits no candidate (shadow_prediction only). */
  extract?: CandidateExtractor;
  /** Best-effort failure log; defaults to a no-op so a telemetry miss is silent to the user. */
  log?: (msg: string) => void;
}

/**
 * shadow_prediction run-event. `actual`/`agreed` are deliberately null — grading happens downstream in
 * runtime/shadow.py (a null actual grades UNSCORED, never a fabricated agreement). Matches core.py shape.
 */
export function shadowPredictionEvent(
  predicted: unknown,
  opts: { field?: string; decisionClass?: string } = {},
): Record<string, unknown> {
  return {
    kind: "shadow_prediction",
    predicted,
    actual: null,
    class: opts.decisionClass ?? "selective",
    field: opts.field ?? "decision_style",
  };
}

/**
 * memory_candidate run-event — shape-identical to a runtime/vault.py candidate record. `source_external_id`
 * IS the vault key (== the Decision-Queue proposal_id for VL-4), so it must be STABLE + unique per fact:
 * we derive it from the turn's conversation + idempotency key, falling back to the conversation id alone.
 */
export function memoryCandidateEvent(
  req: TurnRequest,
  cand: Candidate,
): Record<string, unknown> {
  const externalId = req.idempotencyKey
    ? `${req.conversationId}:${req.idempotencyKey}`
    : req.conversationId;
  return {
    content: cand.content,
    confidence: cand.confidence,
    category: cand.category ?? "conversation",
    provenance: {
      source_adapter: "matrix",
      source_external_id: externalId,
      author_type: cand.authorType ?? "user",
      author_id: cand.authorId ?? req.userId ?? "",
    },
    dedup_key: externalId,
  };
}

/**
 * Build the best-effort turn write-trigger. `onTurn(req, env)` records a shadow_prediction always and a
 * memory_candidate when the extractor surfaces one — each guarded independently so one failing write never
 * suppresses the other, and NEITHER ever throws into the caller. Returns void; the caller may `void` it.
 */
export function makeWriteTrigger(opts: WriteTriggerOpts) {
  const log = opts.log ?? (() => {});
  return async function onTurn(req: TurnRequest, env: ReplyEnvelope): Promise<void> {
    // Only conversational replies carry a prediction; a task envelope isn't a decision-style prediction.
    if (env.kind === "reply" && opts.sink.recordShadowPrediction) {
      try {
        await opts.sink.recordShadowPrediction(shadowPredictionEvent(env.text));
      } catch (e) {
        log(`write-trigger: shadow_prediction persist failed (non-fatal): ${errMsg(e)}`);
      }
    }
    if (opts.extract && opts.sink.recordCandidate) {
      let cand: Candidate | null | undefined;
      try {
        cand = await opts.extract(req, env);
      } catch (e) {
        log(`write-trigger: extractor threw (non-fatal): ${errMsg(e)}`);
        cand = null;
      }
      if (cand) {
        try {
          await opts.sink.recordCandidate(memoryCandidateEvent(req, cand));
        } catch (e) {
          log(`write-trigger: memory_candidate persist failed (non-fatal): ${errMsg(e)}`);
        }
      }
    }
  };
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
