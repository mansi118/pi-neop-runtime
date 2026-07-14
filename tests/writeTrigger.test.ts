/**
 * Write-trigger — pure unit tests (no server, no network). Verifies the run-event shapes match the
 * Python readers (runtime/shadow.py shadow_prediction, runtime/vault.py candidate contract) and that the
 * trigger is BEST-EFFORT: it never throws and never lets one failing write suppress the other.
 */
import { describe, it, expect, vi } from "vitest";
import {
  shadowPredictionEvent,
  memoryCandidateEvent,
  makeWriteTrigger,
  type Candidate,
} from "../src/seat/writeTrigger.ts";
import type { TurnRequest } from "../src/seat/wrapper.ts";
import type { ReplyEnvelope } from "../src/seat/reply.ts";

const REQ: TurnRequest = {
  message: "what's our refund policy?",
  conversationId: "!room:hs",
  userId: "@u:hs",
  idempotencyKey: "evt-9",
};
const REPLY: ReplyEnvelope = { kind: "reply", text: "30 days, no questions asked." };

describe("shadowPredictionEvent", () => {
  it("carries predicted, a null actual (unscored downstream), and the core.py shape", () => {
    expect(shadowPredictionEvent("hello")).toEqual({
      kind: "shadow_prediction",
      predicted: "hello",
      actual: null, // never fabricate an actual/agreement — runtime/shadow.py grades a null actual UNSCORED
      class: "selective",
      field: "decision_style",
    });
    expect(shadowPredictionEvent("x", { decisionClass: "critical", field: "tone" })).toMatchObject(
      { class: "critical", field: "tone" });
  });
});

describe("memoryCandidateEvent", () => {
  it("matches vault.py's candidate contract; source_external_id = conversation:idempotency (the vault key)", () => {
    const cand: Candidate = { content: "refunds are 30 days", confidence: 0.82, category: "policy" };
    expect(memoryCandidateEvent(REQ, cand)).toEqual({
      content: "refunds are 30 days",
      confidence: 0.82,
      category: "policy",
      provenance: {
        source_adapter: "matrix",
        source_external_id: "!room:hs:evt-9",
        author_type: "user",
        author_id: "@u:hs",
      },
      dedup_key: "!room:hs:evt-9",
    });
  });

  it("falls back to the conversation id alone when there is no idempotency key", () => {
    const ev = memoryCandidateEvent({ ...REQ, idempotencyKey: "" }, { content: "c", confidence: 0.5 });
    expect((ev.provenance as any).source_external_id).toBe("!room:hs");
    expect(ev.category).toBe("conversation"); // default category
  });
});

describe("makeWriteTrigger", () => {
  it("records a shadow_prediction for a reply; no candidate without an extractor", async () => {
    const sink = { recordShadowPrediction: vi.fn(async () => {}), recordCandidate: vi.fn(async () => {}) };
    await makeWriteTrigger({ sink, neopId: "aria" })(REQ, REPLY);
    expect(sink.recordShadowPrediction).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "shadow_prediction", predicted: REPLY.text }));
    expect(sink.recordCandidate).not.toHaveBeenCalled(); // default extractor = none, no fabricated confidence
  });

  it("records a memory_candidate when the extractor surfaces one", async () => {
    const sink = { recordShadowPrediction: vi.fn(async () => {}), recordCandidate: vi.fn(async () => {}) };
    const extract = () => ({ content: "fact", confidence: 0.9 });
    await makeWriteTrigger({ sink, neopId: "aria", extract })(REQ, REPLY);
    expect(sink.recordCandidate).toHaveBeenCalledWith(
      expect.objectContaining({ content: "fact", confidence: 0.9 }));
  });

  it("does NOT predict on a task envelope (not a decision-style reply)", async () => {
    const sink = { recordShadowPrediction: vi.fn(async () => {}) };
    await makeWriteTrigger({ sink, neopId: "aria" })(REQ, { kind: "task", text: "done" });
    expect(sink.recordShadowPrediction).not.toHaveBeenCalled();
  });

  it("is BEST-EFFORT: a throwing shadow sink never throws and never blocks the candidate write", async () => {
    const log = vi.fn();
    const sink = {
      recordShadowPrediction: async () => { throw new Error("palace down"); },
      recordCandidate: vi.fn(async () => {}),
    };
    const extract = () => ({ content: "fact", confidence: 0.9 });
    await expect(makeWriteTrigger({ sink, neopId: "aria", extract, log })(REQ, REPLY)).resolves.toBeUndefined();
    expect(sink.recordCandidate).toHaveBeenCalled(); // shadow failure did not suppress the candidate
    expect(log).toHaveBeenCalledWith(expect.stringContaining("shadow_prediction persist failed"));
  });

  it("a throwing extractor is swallowed (no candidate, still no throw)", async () => {
    const log = vi.fn();
    const sink = { recordShadowPrediction: vi.fn(async () => {}), recordCandidate: vi.fn(async () => {}) };
    const extract = () => { throw new Error("boom"); };
    await expect(makeWriteTrigger({ sink, neopId: "aria", extract, log })(REQ, REPLY)).resolves.toBeUndefined();
    expect(sink.recordCandidate).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringContaining("extractor threw"));
  });
});
