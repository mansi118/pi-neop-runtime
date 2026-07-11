/**
 * NEop reasoning loop (Haiku + Sonnet) — pure orchestration, unit-tested with stub Generates + memory.
 * Proves: GROUND filters memory, ANSWER grounds only in the kept set, GUARD blocks a bad draft (fallback),
 * and the loop composes them with honest meta. No live model.
 */
import { describe, it, expect, vi } from "vitest";
import {
  ground,
  answer,
  guard,
  replyLoop,
  answerSystem,
  LOOP_FALLBACK,
  type LoopDeps,
} from "../src/seat/loop.ts";
import type { SeatNeop, MemoryLike } from "../src/seat/reply.ts";

const NEOP: SeatNeop = { rolePrompt: "You are Aria, an outreach assistant.", neopId: "aria" };
const mem = (retrieval: unknown[]): MemoryLike => ({ assembleContext: async () => ({ retrieval }) });

describe("ground (Haiku memory filter)", () => {
  it("skips the model and returns empty when there is no retrieval", async () => {
    const fast = vi.fn(async () => "should not be called");
    expect(await ground(fast, "hi", [])).toBe("");
    expect(fast).not.toHaveBeenCalled();
  });
  it("returns the model's kept snippets, and empty on (none)", async () => {
    expect(await ground(async () => "- keep this", "q", ["a", "b"])).toBe("- keep this");
    expect(await ground(async () => "(none)", "q", ["junk"])).toBe("");
    expect(await ground(async () => "  (None).  ", "q", ["junk"])).toBe("");
  });
});

describe("answer (Sonnet)", () => {
  it("system carries the persona + how-to-answer rules; user carries the grounded memory", async () => {
    let seenSystem = "", seenUser = "";
    const quality = async (s: string, u: string) => { seenSystem = s; seenUser = u; return "  drafted  "; };
    const out = await answer(quality, NEOP, "draft an opener", "- fact A");
    expect(out).toBe("drafted"); // trimmed
    expect(seenSystem).toContain("You are Aria");
    expect(seenSystem).toContain("NEVER invent facts");
    expect(seenUser).toContain("draft an opener");
    expect(seenUser).toContain("- fact A");
  });
  it("passes '(no relevant memory)' when grounded is empty", async () => {
    let seenUser = "";
    await answer(async (_s, u) => { seenUser = u; return "x"; }, NEOP, "q", "");
    expect(seenUser).toContain("(no relevant memory)");
  });
  it("answerSystem embeds the role prompt", () => {
    expect(answerSystem(NEOP)).toContain("You are Aria");
  });
});

describe("guard (Haiku)", () => {
  it("passes on ok:true, blocks on ok:false, tolerates parse/throw failures", async () => {
    expect(await guard(async () => '{"ok": true}', "d")).toBe(true);
    expect(await guard(async () => 'nope {"ok": false, "reason": "leak"} tail', "d")).toBe(false);
    expect(await guard(async () => "not json at all", "d")).toBe(true); // parse fail -> don't block
    expect(await guard(async () => { throw new Error("model down"); }, "d")).toBe(true);
  });
});

describe("replyLoop — GROUND -> ANSWER -> GUARD", () => {
  const deps = (over: Partial<LoopDeps>): LoopDeps => ({
    fast: async (sys: string) => (sys.includes("relevance filter") ? "- kept" : '{"ok": true}'),
    quality: async () => "Here is a crisp, on-persona answer.",
    memory: mem(["relevant fact", "junk about bioluminescence"]),
    ...over,
  });

  it("happy path: returns the Sonnet draft with honest meta", async () => {
    const env = await replyLoop(NEOP, { message: "who is our ICP?" }, deps({}));
    expect(env.kind).toBe("reply");
    expect(env.text).toBe("Here is a crisp, on-persona answer.");
    expect(env.meta).toMatchObject({
      neopId: "aria",
      retrievalCount: 2,
      groundedKept: 1,
      guarded: true,
      loop: "haiku-ground+sonnet-answer+haiku-guard",
    });
  });

  it("guard rejects the draft -> safe fallback (not the bad draft)", async () => {
    const fast = async (sys: string) => (sys.includes("relevance filter") ? "- kept" : '{"ok": false, "reason": "leak"}');
    const env = await replyLoop(NEOP, { message: "x" }, deps({ fast }));
    expect(env.text).toBe(LOOP_FALLBACK);
    expect(env.meta).toMatchObject({ guarded: false });
  });

  it("empty draft -> fallback without even guarding", async () => {
    const env = await replyLoop(NEOP, { message: "x" }, deps({ quality: async () => "   " }));
    expect(env.text).toBe(LOOP_FALLBACK);
    expect(env.meta).toMatchObject({ guarded: false });
  });

  it("no retrieval -> grounded empty, still answers", async () => {
    const env = await replyLoop(NEOP, { message: "hi" }, deps({ memory: mem([]) }));
    expect(env.meta).toMatchObject({ retrievalCount: 0, groundedKept: 0 });
    expect(env.text).toBe("Here is a crisp, on-persona answer.");
  });
});
