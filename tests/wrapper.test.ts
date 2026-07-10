/**
 * Seat wrapper — the security core (auth, scope-spoof rejection, T9 gate, routing, graceful errors) unit
 * tested with NO network/model, plus one real node:http round-trip. The LIVE turn (real model + palace)
 * is T9 + box-gated, NOT run here — `makeLiveHandlers` is proven to REFUSE without the ack, not to serve.
 */
import { describe, it, expect } from "vitest";
import {
  authOk,
  constantTimeEqual,
  parseTurn,
  handleTurn,
  assertWrapperConfig,
  makeLiveHandlers,
  renderRunResult,
  runTaskResilient,
  serveTurn,
  type SeatHandlers,
  type TurnRequest,
  type WrapperConfig,
} from "../src/seat/wrapper.ts";
import type { RouteDecision } from "../src/seat/intent.ts";
import type { ReplyEnvelope } from "../src/seat/reply.ts";

const CONFIG: WrapperConfig = { forwardToken: "SECRET-TOKEN", t9Ack: false };
const conv = (route: "conversational" | "actionable"): RouteDecision => ({
  route,
  classification: { intent: route, confidence: 0.9 },
  reason: "",
});
function handlers(route: "conversational" | "actionable", calls: string[] = []): SeatHandlers {
  return {
    classify: async () => conv(route),
    reply: async (r: TurnRequest) => {
      calls.push("reply");
      return { kind: "reply", text: `reply:${r.message}` } as ReplyEnvelope;
    },
    runTask: async (r: TurnRequest) => {
      calls.push("runTask");
      return { kind: "task", text: `task:${r.message}` } as ReplyEnvelope;
    },
  };
}
const goodBody = JSON.stringify({ message: "hello", conversationId: "!room:server", userId: "@u:server" });

describe("constantTimeEqual / authOk", () => {
  it("equal strings match, unequal don't, length mismatch is false (no throw)", () => {
    expect(constantTimeEqual("abc", "abc")).toBe(true);
    expect(constantTimeEqual("abc", "abd")).toBe(false);
    expect(constantTimeEqual("abc", "abcd")).toBe(false); // different length, must not throw
  });
  it("authOk requires a correct Bearer token", () => {
    expect(authOk("Bearer SECRET-TOKEN", "SECRET-TOKEN")).toBe(true);
    expect(authOk("Bearer WRONG", "SECRET-TOKEN")).toBe(false);
    expect(authOk("SECRET-TOKEN", "SECRET-TOKEN")).toBe(false); // missing "Bearer "
    expect(authOk(undefined, "SECRET-TOKEN")).toBe(false);
    expect(authOk("Bearer x", "")).toBe(false); // blank server token never authorizes
  });
});

describe("parseTurn — validation + scope-spoof rejection", () => {
  it("accepts a well-formed turn", () => {
    const r = parseTurn(goodBody);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.req.message).toBe("hello");
  });
  it("rejects non-JSON / non-object", () => {
    expect(parseTurn("not json").ok).toBe(false);
    expect(parseTurn("[]").ok).toBe(false);
  });
  it("REJECTS LOUDLY when the caller supplies scope/envelope keys (scope is env-baked)", () => {
    for (const k of ["palaceId", "neopId", "tool", "params", "scope"]) {
      const body = JSON.stringify({ message: "hi", conversationId: "!r:s", [k]: "x" });
      const r = parseTurn(body);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.errcode).toBe("M_SCOPE_SPOOF");
    }
  });
  it("requires a non-empty message and a conversationId", () => {
    expect(parseTurn(JSON.stringify({ conversationId: "!r:s" })).ok).toBe(false); // no message
    expect(parseTurn(JSON.stringify({ message: "  ", conversationId: "!r:s" })).ok).toBe(false); // blank
    expect(parseTurn(JSON.stringify({ message: "hi" })).ok).toBe(false); // no conversationId
  });
});

describe("handleTurn — auth → parse → route", () => {
  it("403 on missing/wrong token (before any parsing)", async () => {
    expect((await handleTurn(undefined, goodBody, handlers("conversational"), CONFIG)).status).toBe(403);
    expect((await handleTurn("Bearer WRONG", goodBody, handlers("conversational"), CONFIG)).status).toBe(403);
  });
  it("400 on bad body (after auth passes)", async () => {
    const out = await handleTurn("Bearer SECRET-TOKEN", "not json", handlers("conversational"), CONFIG);
    expect(out.status).toBe(400);
  });
  it("routes conversational → reply handler, returns the envelope", async () => {
    const calls: string[] = [];
    const out = await handleTurn("Bearer SECRET-TOKEN", goodBody, handlers("conversational", calls), CONFIG);
    expect(out.status).toBe(200);
    expect((out.body as ReplyEnvelope).kind).toBe("reply");
    expect(calls).toEqual(["reply"]);
  });
  it("routes actionable → runTask handler", async () => {
    const calls: string[] = [];
    const out = await handleTurn("Bearer SECRET-TOKEN", goodBody, handlers("actionable", calls), CONFIG);
    expect(out.status).toBe(200);
    expect((out.body as ReplyEnvelope).kind).toBe("task");
    expect(calls).toEqual(["runTask"]);
  });
  it("500 with a graceful body (no stack) when a handler throws", async () => {
    const throwing: SeatHandlers = {
      classify: async () => conv("conversational"),
      reply: async () => {
        throw new Error("boom secret internal detail");
      },
      runTask: async () => ({ kind: "task", text: "" }) as ReplyEnvelope,
    };
    const out = await handleTurn("Bearer SECRET-TOKEN", goodBody, throwing, CONFIG);
    expect(out.status).toBe(500);
    expect(JSON.stringify(out.body)).not.toContain("boom secret internal detail");
  });
});

describe("assertWrapperConfig — fail-closed on blank token", () => {
  it("throws on blank FORWARD_TOKEN", () => {
    expect(() => assertWrapperConfig({} as NodeJS.ProcessEnv)).toThrow(/FORWARD_TOKEN is blank/);
    expect(() => assertWrapperConfig({ FORWARD_TOKEN: "   " } as any)).toThrow(/FORWARD_TOKEN is blank/);
  });
  it("reads the token and the T9 ack", () => {
    expect(assertWrapperConfig({ FORWARD_TOKEN: "t" } as any)).toEqual({ forwardToken: "t", t9Ack: false });
    expect(assertWrapperConfig({ FORWARD_TOKEN: "t", NEOP_T9_ACK: "yes" } as any).t9Ack).toBe(true);
    expect(assertWrapperConfig({ FORWARD_TOKEN: "t", NEOP_T9_ACK: "true" } as any).t9Ack).toBe(false); // only "yes"
  });
});

describe("makeLiveHandlers — the T9 gate", () => {
  it("REFUSES to assemble live handlers without NEOP_T9_ACK (the first-real-NEop gate)", () => {
    expect(() =>
      makeLiveHandlers({
        neopPath: "x",
        neop: { rolePrompt: "p", neopId: "n" },
        model: {} as any,
        memory: {} as any,
        t9Ack: false,
      }),
    ).toThrow(/T9/);
  });
});

describe("renderRunResult — RunResult → reply (Phase-1 containment)", () => {
  const base = { runId: "r1", neop: "n", caseId: "c", plan: null, replansPerformed: 0, trace: {} as any };
  it("DONE → a task envelope summarizing steps", () => {
    const env = renderRunResult({ ...base, terminalState: "DONE", taskOutcomes: [{}, {}] as any, acceptanceAllPass: true });
    expect(env.kind).toBe("task");
    expect(env.text).toMatch(/Done — completed 2 steps/);
  });
  it("ESCALATED → an approval-needed message (Phase-1 deny, does not act)", () => {
    const env = renderRunResult({ ...base, terminalState: "ESCALATED", taskOutcomes: [], acceptanceAllPass: false });
    expect(env.text).toMatch(/requires approval/i);
  });
  it("FAILED → a graceful failure line", () => {
    const env = renderRunResult({ ...base, terminalState: "FAILED", taskOutcomes: [], acceptanceAllPass: false, error: "nope" });
    expect(env.text).toMatch(/couldn't complete/i);
  });
});

describe("runTaskResilient — task-engine throw degrades to a reply (the task-path-500 fix)", () => {
  const base = { runId: "r1", neop: "n", caseId: "c", plan: null, replansPerformed: 0, trace: {} as any };
  const req: TurnRequest = { message: "draft an opener", conversationId: "!r:s", userId: "", idempotencyKey: "" };
  const reply = async (r: TurnRequest) => ({ kind: "reply", text: `reply:${r.message}` }) as ReplyEnvelope;

  it("a DONE result renders normally (no fallback)", async () => {
    const env = await runTaskResilient(
      req,
      async () => ({ ...base, terminalState: "DONE", taskOutcomes: [{}] as any, acceptanceAllPass: true }),
      reply,
    );
    expect(env.kind).toBe("task");
    expect(env.text).toMatch(/Done — completed 1 step/);
  });

  it("a THROW in the task engine falls back to a conversational reply (was a 500)", async () => {
    const env = await runTaskResilient(
      req,
      async () => {
        throw new Error("empty plan / task engine blew up");
      },
      reply,
    );
    expect(env.kind).toBe("reply");
    expect(env.text).toBe("reply:draft an opener");
  });

  it("a non-DONE TERMINAL state still renders via renderRunResult (not the fallback)", async () => {
    const env = await runTaskResilient(
      req,
      async () => ({ ...base, terminalState: "ESCALATED", taskOutcomes: [], acceptanceAllPass: false }),
      reply,
    );
    expect(env.kind).toBe("task");
    expect(env.text).toMatch(/requires approval/i);
  });
});

describe("serveTurn — real node:http round-trip (thin transport shell)", () => {
  async function boot(h: SeatHandlers) {
    const server = serveTurn(CONFIG, h, { port: 0 });
    if (!server.listening) await new Promise<void>((r) => server.on("listening", () => r()));
    const addr = server.address() as { port: number };
    return {
      base: `http://127.0.0.1:${addr.port}`,
      close: () => new Promise<void>((r) => server.close(() => r())),
    };
  }
  it("POST /seat/turn with the token → 200 envelope; without → 403; wrong path → 404", async () => {
    const s = await boot(handlers("conversational"));
    try {
      const ok = await fetch(`${s.base}/seat/turn`, {
        method: "POST",
        headers: { Authorization: "Bearer SECRET-TOKEN", "Content-Type": "application/json" },
        body: goodBody,
      });
      expect(ok.status).toBe(200);
      expect(((await ok.json()) as { kind: string }).kind).toBe("reply");

      const noAuth = await fetch(`${s.base}/seat/turn`, { method: "POST", body: goodBody });
      expect(noAuth.status).toBe(403);

      const wrongPath = await fetch(`${s.base}/nope`, { method: "POST", body: goodBody });
      expect(wrongPath.status).toBe(404);
    } finally {
      await s.close();
    }
  });
});
