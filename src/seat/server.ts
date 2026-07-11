/**
 * Seat server bootstrap — the LIVE entrypoint that assembles the seat wrapper from env and starts it.
 * (b-fwd-seam-design.md; the runnable process behind Component 1.)
 *
 * T9 STOP-AND-ASK, GATED EARLY: the ack is checked BEFORE any live broker is constructed, so a process
 * lacking NEOP_T9_ACK=yes REFUSES before it opens a live model connection or a live palace connection —
 * fail-fast, the same posture as assertWrapperConfig refusing on a blank token. Standing this up IS the
 * first-real-NEop crossing (T9); running it is box-side + yours. The ASSEMBLY's REFUSAL is unit-tested (no
 * ack → throws AND no factory is called); its PASSAGE (a live turn) is not — that proves out on the box.
 */
import type { Server } from "node:http";
import { ModelBroker } from "../brokers/model.ts";
import { MemoryBroker } from "../brokers/memory.ts";
import { load } from "../loader.ts";
import { assertWrapperConfig, makeLiveHandlers, serveTurn, type SeatHandlers, type WrapperConfig } from "./wrapper.ts";
import type { MemoryLike, SeatNeop } from "./reply.ts";

/** Injectable live-dep factories — so the T9 refusal is unit-testable WITHOUT constructing live brokers. */
export interface SeatServerDeps {
  // Two brokers for the Haiku+Sonnet loop: fast (Haiku) drives classify/ground/guard, quality (Sonnet) answers.
  makeFast: () => ModelBroker;
  makeQuality: () => ModelBroker;
  makeMemory: () => MemoryLike;
  loadNeop: (path: string) => SeatNeop;
}

/**
 * Assemble the live seat handlers. The T9 gate (and the NEOP_PATH check) are evaluated FIRST — if either
 * fails, this throws BEFORE calling any factory, so NO live model/palace connection is established on
 * refusal. (Tests assert the factories are never invoked when t9Ack is false.)
 */
export function assembleSeatServer(config: WrapperConfig, neopPath: string, deps: SeatServerDeps): SeatHandlers {
  if (!config.t9Ack) {
    throw new Error(
      "REFUSING to assemble the live seat server: this IS the first-real-NEop gate (T9). No live model or " +
        "palace connection is opened until NEOP_T9_ACK=yes AND B (GAP-1 ranked retrieval) + A2 (classifier " +
        "injection-resistance) are proven box-side. Set NEOP_T9_ACK=yes only as the conscious crossing.",
    );
  }
  if (!neopPath.trim()) {
    throw new Error("NEOP_PATH is required (the seat's NEop folder, e.g. agents/recon)");
  }
  // Only past BOTH gates do we open anything live:
  const fast = deps.makeFast(); // live Haiku connection
  const quality = deps.makeQuality(); // live Sonnet connection
  const memory = deps.makeMemory(); // live palace (palaceClientFromEnv — scope baked from env, never payload)
  const neop = deps.loadNeop(neopPath);
  return makeLiveHandlers({ neopPath, neop, fast, quality, memory, t9Ack: config.t9Ack });
}

/** The real bootstrap: env → config (fail-closed on blank token) → T9-gated live assembly → node:http server. */
export function runSeatServer(env: NodeJS.ProcessEnv = process.env): Server {
  const config = assertWrapperConfig(env); // throws on blank FORWARD_TOKEN (fail-closed)
  const neopPath = (env.NEOP_PATH ?? "").trim();
  const handlers = assembleSeatServer(config, neopPath, {
    // Fast=Haiku, Quality=Sonnet — ids overridable per-seat via env; NRT_MODEL still drives the task path.
    makeFast: () =>
      new ModelBroker("live", env.SEAT_MODEL_FAST || "global.anthropic.claude-haiku-4-5-20251001-v1:0"),
    makeQuality: () =>
      new ModelBroker("live", env.SEAT_MODEL_QUALITY || "global.anthropic.claude-sonnet-4-5-20250929-v1:0"),
    makeMemory: () => new MemoryBroker("live"), // MemoryBroker satisfies MemoryLike; scope from env, fail-closed
    loadNeop: (p) => load(p),
  });
  const port = Number(env.SEAT_PORT ?? "8090");
  const host = env.SEAT_HOST ?? "127.0.0.1";
  return serveTurn(config, handlers, { port, host, log: (s) => console.error(s) });
}
