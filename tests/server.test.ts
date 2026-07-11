/**
 * Seat bootstrap — the T9 gate is proven to REFUSE before wiring anything live. This is gate-LOGIC; it
 * crosses nothing (factories are fakes). The PASSAGE (a real live turn) is box-side + T9, not tested here.
 */
import { describe, it, expect } from "vitest";
import { assembleSeatServer } from "../src/seat/server.ts";
import type { WrapperConfig } from "../src/seat/wrapper.ts";

const cfg = (t9Ack: boolean): WrapperConfig => ({ forwardToken: "TOK", t9Ack });

function recordingDeps(calls: string[]) {
  return {
    makeFast: () => {
      calls.push("fast");
      return {} as any; // makeLiveHandlers reads the brokers lazily; assembly doesn't touch them
    },
    makeQuality: () => {
      calls.push("quality");
      return {} as any;
    },
    makeMemory: () => {
      calls.push("memory");
      return { async assembleContext() { return { retrieval: [] }; } };
    },
    loadNeop: (p: string) => {
      calls.push(`neop:${p}`);
      return { rolePrompt: "persona", neopId: "recon" };
    },
  };
}

describe("assembleSeatServer — T9 gate checked BEFORE any live broker is constructed", () => {
  it("REFUSES without NEOP_T9_ACK, and constructs NO live brokers (no model/palace connection opened)", () => {
    const calls: string[] = [];
    expect(() => assembleSeatServer(cfg(false), "agents/recon", recordingDeps(calls))).toThrow(/T9/);
    expect(calls).toEqual([]); // fail-fast: nothing live was wired on refusal
  });

  it("REFUSES on blank NEOP_PATH (even with the ack) and still constructs NO brokers", () => {
    const calls: string[] = [];
    expect(() => assembleSeatServer(cfg(true), "   ", recordingDeps(calls))).toThrow(/NEOP_PATH/);
    expect(calls).toEqual([]);
  });

  it("with the ack + a path, constructs the deps IN ORDER and returns handlers", () => {
    const calls: string[] = [];
    const handlers = assembleSeatServer(cfg(true), "agents/recon", recordingDeps(calls));
    expect(typeof handlers.classify).toBe("function");
    expect(typeof handlers.reply).toBe("function");
    expect(typeof handlers.runTask).toBe("function");
    expect(calls).toEqual(["fast", "quality", "memory", "neop:agents/recon"]); // only reached AFTER both gates
  });
});
