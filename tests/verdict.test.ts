/**
 * Seat verdict handler — pure unit tests (no server, no network). The storable event shape matches the
 * Python runtime.shadow.human_verdict_event 1:1; the handler persists under THIS seat's scope only.
 */
import { describe, it, expect, vi } from "vitest";
import { humanVerdictEvent, parseVerdict, makeVerdictHandler } from "../src/seat/verdict.ts";

describe("humanVerdictEvent", () => {
  it("approve → agreed:true; reject → false; bool accepted; shape matches the Python writer", () => {
    const ap = humanVerdictEvent("approve", { proposalId: "p1" });
    expect(ap).toEqual({
      kind: "human_verdict", agreed: true, field: "decision_style",
      signal_kind: "structural", decision_class: "selective", proposal_id: "p1",
    });
    expect(humanVerdictEvent("reject").agreed).toBe(false);
    expect(humanVerdictEvent(true).agreed).toBe(true);
    expect(humanVerdictEvent("approve").proposal_id).toBe(null); // absent → null
  });
});

describe("parseVerdict", () => {
  it("accepts approve/reject and both proposalId spellings", () => {
    expect(parseVerdict('{"verdict":"approve","seat":"aria","proposalId":"p1"}')).toMatchObject(
      { ok: true, verdict: "approve", seat: "aria", proposalId: "p1" });
    expect(parseVerdict('{"verdict":"reject","proposal_id":"p2"}')).toMatchObject(
      { ok: true, verdict: "reject", proposalId: "p2" });
  });
  it("rejects non-JSON, non-object, and bad verdict", () => {
    expect(parseVerdict("not json")).toMatchObject({ ok: false, errcode: "M_NOT_JSON" });
    expect(parseVerdict("[]")).toMatchObject({ ok: false, errcode: "M_BAD_JSON" });
    expect(parseVerdict('{"verdict":"maybe"}')).toMatchObject({ ok: false, errcode: "M_BAD_VERDICT" });
    expect(parseVerdict("{}")).toMatchObject({ ok: false, errcode: "M_BAD_VERDICT" });
  });
});

describe("makeVerdictHandler", () => {
  it("persists a human-verdict event and returns 200 ok", async () => {
    const memory = { recordVerdict: vi.fn(async () => {}) };
    const h = makeVerdictHandler({ memory, neopId: "aria" });
    const out = await h('{"verdict":"approve","seat":"aria","proposalId":"p1"}');
    expect(out).toEqual({ status: 200, body: { status: "ok" } });
    expect(memory.recordVerdict).toHaveBeenCalledWith(expect.objectContaining(
      { kind: "human_verdict", agreed: true, proposal_id: "p1" }));
  });

  it("rejects a mis-routed verdict (seat != this seat) with 409, without persisting", async () => {
    const memory = { recordVerdict: vi.fn(async () => {}) };
    const out = await makeVerdictHandler({ memory, neopId: "aria" })('{"verdict":"approve","seat":"recon"}');
    expect(out.status).toBe(409);
    expect((out.body as any).errcode).toBe("M_SEAT_MISMATCH");
    expect(memory.recordVerdict).not.toHaveBeenCalled();
  });

  it("400 on a bad body; 500 when there is no sink; 500 when the sink throws", async () => {
    expect((await makeVerdictHandler({ memory: {}, neopId: "aria" })("nope")).status).toBe(400);
    expect((await makeVerdictHandler({ memory: {}, neopId: "aria" })('{"verdict":"approve"}')).status).toBe(500); // no recordVerdict
    const throwing = { recordVerdict: async () => { throw new Error("palace down"); } };
    expect((await makeVerdictHandler({ memory: throwing, neopId: "aria" })('{"verdict":"approve"}')).status).toBe(500);
  });
});
