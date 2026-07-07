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
 * A single-turn, tool-less, memory-backed reply. NOTE the GAP-1 dependency above: retrieval quality is NOT
 * proven here (it is mocked); this proves the PATH, not the memory.
 */
export async function replySeat(
  neop: SeatNeop,
  msg: { message: string },
  deps: { gen: Generate; memory: MemoryLike },
): Promise<ReplyEnvelope> {
  const ctx = await deps.memory.assembleContext(msg.message); // GAP-1 live retrieval (box-unproven; mocked in tests)
  const user = `${msg.message}\n\n# Memory context\n${renderRetrieval(ctx.retrieval)}`;
  const text = await deps.gen(neop.rolePrompt, user); // tool-less: a reply, not an action
  return {
    kind: "reply",
    text,
    meta: { neopId: neop.neopId, retrievalCount: ctx.retrieval?.length ?? 0 },
  };
}
