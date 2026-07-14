/**
 * Candidate extractor — pure unit tests over an injected Generate stub (no live model). Verifies it emits
 * an HONEST-confidence candidate only for a genuine durable fact, abstains otherwise, floors low confidence,
 * survives model errors / garbage, and skips task envelopes.
 */
import { describe, it, expect, vi } from "vitest";
import { makeHaikuExtractor, parseExtraction, CONFIDENCE_FLOOR } from "../src/seat/candidateExtractor.ts";
import type { TurnRequest } from "../src/seat/wrapper.ts";
import type { ReplyEnvelope } from "../src/seat/reply.ts";

const REQ: TurnRequest = { message: "I always prefer async standups", conversationId: "!r", userId: "@u", idempotencyKey: "e1" };
const REPLY: ReplyEnvelope = { kind: "reply", text: "Got it — async standups it is." };
const gen = (out: string) => vi.fn(async () => out);

describe("parseExtraction", () => {
  it("returns a candidate for remember:true with an honest confidence above the floor", () => {
    const c = parseExtraction('{"remember":true,"content":"User prefers async standups","confidence":0.9,"category":"preference"}');
    expect(c).toEqual({ content: "User prefers async standups", confidence: 0.9, category: "preference" });
  });
  it("abstains on remember:false, empty content, or missing JSON", () => {
    expect(parseExtraction('{"remember":false}')).toBeNull();
    expect(parseExtraction('{"remember":true,"content":"  ","confidence":0.9}')).toBeNull();
    expect(parseExtraction("no json here")).toBeNull();
    expect(parseExtraction("not{valid")).toBeNull();
  });
  it("floors low confidence to null and never fabricates one (missing → 0 → null)", () => {
    expect(parseExtraction(`{"remember":true,"content":"x","confidence":${CONFIDENCE_FLOOR - 0.01}}`)).toBeNull();
    expect(parseExtraction('{"remember":true,"content":"x"}')).toBeNull(); // no confidence ⇒ 0 ⇒ below floor
  });
  it("clamps an out-of-range confidence and defaults category", () => {
    const c = parseExtraction('{"remember":true,"content":"x","confidence":1.7}');
    expect(c).toEqual({ content: "x", confidence: 1, category: "conversation" });
  });
});

describe("makeHaikuExtractor", () => {
  it("extracts a candidate from a durable-fact turn", async () => {
    const fast = gen('{"remember":true,"content":"User prefers async standups","confidence":0.88,"category":"preference"}');
    const cand = await makeHaikuExtractor(fast)(REQ, REPLY);
    expect(cand).toMatchObject({ content: "User prefers async standups", confidence: 0.88 });
    // the exchange (user + reply) is passed to the model as data
    expect(fast).toHaveBeenCalledWith(expect.stringContaining("extract DURABLE MEMORY"), expect.stringContaining("async standups"));
  });
  it("returns null on a model error (best-effort, never throws)", async () => {
    const fast = vi.fn(async () => { throw new Error("bedrock down"); });
    await expect(makeHaikuExtractor(fast)(REQ, REPLY)).resolves.toBeNull();
  });
  it("skips a task envelope without calling the model", async () => {
    const fast = gen('{"remember":true,"content":"x","confidence":0.9}');
    expect(await makeHaikuExtractor(fast)(REQ, { kind: "task", text: "done" })).toBeNull();
    expect(fast).not.toHaveBeenCalled();
  });
});
