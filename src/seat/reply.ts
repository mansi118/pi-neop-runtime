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
 * Best relevance score across retrieved chunks (max of `confidence`/`score`/`_score`), for telemetry only.
 * Lets the per-turn log show WHETHER retrieval was actually relevant — palace_search returns nearest
 * neighbours with no threshold, so a low top score on an off-topic query is the signal that the "memory
 * context" fed to the model was weak. Returns undefined if no numeric score is present.
 */
export function topRetrievalScore(retrieval: unknown[]): number | undefined {
  let best: number | undefined;
  for (const r of retrieval ?? []) {
    if (r && typeof r === "object") {
      const o = r as Record<string, unknown>;
      const s = [o.confidence, o.score, o._score].find((v) => typeof v === "number") as number | undefined;
      if (typeof s === "number" && (best === undefined || s > best)) best = s;
    }
  }
  return best;
}

/**
 * A single-turn, tool-less, memory-backed reply. NOTE the GAP-1 dependency above: retrieval quality is NOT
 * proven here (it is mocked); this proves the PATH, not the memory.
 */
export async function replySeat(
  neop: SeatNeop,
  msg: { message: string },
  deps: { gen: Generate; memory: MemoryLike },
): Promise<ReplyEnvelope> {
  const tRet = Date.now();
  const ctx = await deps.memory.assembleContext(msg.message); // GAP-1 live retrieval (box-unproven; mocked in tests)
  const retrievalMs = Date.now() - tRet;
  const user = `${msg.message}\n\n# Memory context\n${renderRetrieval(ctx.retrieval)}`;
  const tGen = Date.now();
  const text = await deps.gen(neop.rolePrompt, user); // tool-less: a reply, not an action
  const genMs = Date.now() - tGen;
  return {
    kind: "reply",
    text,
    // meta carries per-turn telemetry up to serveTurn's structured log (timings + retrieval quality). The
    // scores make the memory-relevance question observable per turn instead of needing a synthetic probe.
    meta: {
      neopId: neop.neopId,
      retrievalCount: ctx.retrieval?.length ?? 0,
      retrievalMs,
      genMs,
      topScore: topRetrievalScore(ctx.retrieval),
    },
  };
}
