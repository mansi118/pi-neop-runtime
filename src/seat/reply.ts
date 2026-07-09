/**
 * Conversational reply path (B-fwd-seam-design.md, Component 3): assembleContext (memory retrieve) + one
 * TOOL-LESS generation → a ReplyEnvelope. This is the memory-backed reply — the actual Bar-2 win.
 *
 * DEPENDENCY ON GAP-1 — marked in CODE, not just the plan (condition B): `memory.assembleContext` IS
 * GAP-1's live palace retrieval — code-complete but box-UNPROVEN (its ranked proof is owed). A green unit
 * test here means "the reply PATH is wired correctly GIVEN that assembleContext returns what it should" — it
 * does NOT mean the memory underneath actually RANKS. Tests MOCK assembleContext. path-green ≠ memory-green;
 * condition B closes that box-side, before the first live turn. responds ≠ ranks.
 */
import type { NeopDefinition } from "../loader.ts";
import type { Generate } from "./generate.ts";

export interface ReplyEnvelope {
  kind: "reply" | "task";
  text: string;
  meta?: Record<string, unknown>;
}

export interface AssembledContext {
  retrieval: unknown[];
  [k: string]: unknown;
}

/** The slice of the memory broker the reply path needs — so tests MOCK the (box-unproven) retrieval. */
export interface MemoryLike {
  assembleContext(input: string): Promise<AssembledContext>;
}

/** Only the persona/id the reply path reads — keeps the dependency explicit and the tests light. */
export type SeatNeop = Pick<NeopDefinition, "rolePrompt" | "neopId">;

function renderRetrieval(retrieval: unknown[]): string {
  if (!retrieval || retrieval.length === 0) return "(no relevant memory)";
  return retrieval.map((r) => `- ${typeof r === "string" ? r : JSON.stringify(r)}`).join("\n");
}

/**
 * The relevance score of a single retrieved chunk. Prefer a QUERY-similarity field (`score`/`_score`/
 * `relevance`) over `confidence` — measured 2026-07-09: the palace's `confidence` is the chunk's STORED
 * confidence (~0.9 for every result, including off-topic queries), NOT query relevance, so thresholding on
 * it can't separate on- from off-topic. If the palace surfaces a real similarity score, this reads it;
 * `confidence` is only a last-resort fallback. Returns undefined if no numeric score is present.
 */
export function chunkScore(r: unknown): number | undefined {
  if (r && typeof r === "object") {
    const o = r as Record<string, unknown>;
    return [o.score, o._score, o.relevance, o.similarity, o.confidence].find((v) => typeof v === "number") as
      | number
      | undefined;
  }
  return undefined;
}

/**
 * Best relevance score across retrieved chunks, for telemetry. Lets the per-turn log show WHETHER retrieval
 * was actually relevant — palace_search returns nearest neighbours with no threshold, so a low top score on
 * an off-topic query is the signal that the "memory context" fed to the model was weak.
 */
export function topRetrievalScore(retrieval: unknown[]): number | undefined {
  let best: number | undefined;
  for (const r of retrieval ?? []) {
    const s = chunkScore(r);
    if (typeof s === "number" && (best === undefined || s > best)) best = s;
  }
  return best;
}

/**
 * Relevance gate: drop chunks whose score is BELOW minScore before they are injected as "memory context".
 * palace_search returns nearest neighbours with no cutoff, so an off-topic query still gets a weak chunk
 * stapled to the prompt (the "memory feels irrelevant" symptom). A chunk with NO score is kept (we can't
 * judge it — never silently drop unscored memory). minScore <= 0 disables the gate (returns input as-is).
 */
export function filterByScore(retrieval: unknown[], minScore: number): unknown[] {
  if (!(minScore > 0)) return retrieval ?? [];
  return (retrieval ?? []).filter((r) => {
    const s = chunkScore(r);
    return s === undefined || s >= minScore;
  });
}

/**
 * A single-turn, tool-less, memory-backed reply. NOTE the GAP-1 dependency above: retrieval quality is NOT
 * proven here (it is mocked); this proves the PATH, not the memory.
 */
export async function replySeat(
  neop: SeatNeop,
  msg: { message: string },
  deps: { gen: Generate; memory: MemoryLike },
  opts: { minScore?: number } = {},
): Promise<ReplyEnvelope> {
  const tRet = Date.now();
  const ctx = await deps.memory.assembleContext(msg.message); // GAP-1 live retrieval (box-unproven; mocked in tests)
  const retrievalMs = Date.now() - tRet;
  const raw = ctx.retrieval ?? [];
  const minScore = opts.minScore ?? 0;
  const kept = filterByScore(raw, minScore); // relevance gate: weak chunks never reach the prompt
  const user = `${msg.message}\n\n# Memory context\n${renderRetrieval(kept)}`;
  const tGen = Date.now();
  const text = await deps.gen(neop.rolePrompt, user); // tool-less: a reply, not an action
  const genMs = Date.now() - tGen;
  return {
    kind: "reply",
    text,
    // meta carries per-turn telemetry up to serveTurn's structured log (timings + retrieval quality). The
    // scores make the memory-relevance question observable per turn instead of needing a synthetic probe.
    // retrievalCount = raw hits; retrievalKept = what actually survived the gate and reached the prompt.
    meta: {
      neopId: neop.neopId,
      retrievalCount: raw.length,
      retrievalKept: kept.length,
      retrievalMs,
      genMs,
      topScore: topRetrievalScore(raw),
      minScore: minScore > 0 ? minScore : undefined,
    },
  };
}
