/**
 * Component 3 (replySeat) WIRING. `memory.assembleContext` is MOCKED — it is GAP-1's box-UNPROVEN live
 * retrieval (condition B). A green here = the reply PATH is wired given retrieval; it is NOT "memory-backed
 * replies work". path-green ≠ memory-green. responds ≠ ranks. The generation is a tool-less fake.
 */
import { describe, it, expect } from "vitest";
import { replySeat, filterByScore, chunkScore, topRetrievalScore, type MemoryLike } from "../src/seat/reply.ts";

const stubNeop = { rolePrompt: "You are Aria, a helpful SDR.", neopId: "aria" };

describe("replySeat — assembleContext + one tool-less generation → ReplyEnvelope", () => {
  it("builds a reply envelope from the (tool-less) generation and consults memory with the message", async () => {
    const memoryCalls: string[] = [];
    const memory: MemoryLike = {
      async assembleContext(input) {
        memoryCalls.push(input);
        return { retrieval: ["seat project = BLUEFERN"] }; // MOCKED retrieval — NOT proven ranking (condition B)
      },
    };
    let genSystem = "";
    let genUser = "";
    const gen = async (system: string, user: string) => {
      genSystem = system;
      genUser = user;
      return "Your project is BLUEFERN.";
    };

    const env = await replySeat(stubNeop, { message: "what's my project?" }, { gen, memory });

    expect(env.kind).toBe("reply");
    expect(env.text).toBe("Your project is BLUEFERN.");
    expect(env.meta?.retrievalCount).toBe(1);
    // retrieval was consulted with the user's message (MOCKED — proves the path calls memory, not that memory ranks):
    expect(memoryCalls).toEqual(["what's my project?"]);
    // the generation saw the persona as system, and the message + memory context as the user turn:
    expect(genSystem).toBe(stubNeop.rolePrompt);
    expect(genUser).toContain("what's my project?");
    expect(genUser).toContain("# Memory context");
    expect(genUser).toContain("BLUEFERN");
  });

  it("empty retrieval renders a placeholder and still replies (empty memory is not an error on the reply path)", async () => {
    const memory: MemoryLike = {
      async assembleContext() {
        return { retrieval: [] };
      },
    };
    const gen = async (_system: string, user: string) =>
      user.includes("(no relevant memory)") ? "OK, noted." : "PLACEHOLDER-MISSING";
    const env = await replySeat(stubNeop, { message: "hi" }, { gen, memory });
    expect(env.text).toBe("OK, noted.");
    expect(env.meta?.retrievalCount).toBe(0);
  });

  it("always returns kind='reply' (never 'task' — this path does not act)", async () => {
    const memory: MemoryLike = { async assembleContext() { return { retrieval: [] }; } };
    const gen = async () => "anything";
    const env = await replySeat(stubNeop, { message: "x" }, { gen, memory });
    expect(env.kind).toBe("reply");
  });
});

describe("relevance gate — filterByScore / chunkScore / topRetrievalScore", () => {
  const chunks = [
    { content: "on-topic", confidence: 0.9 },
    { content: "weak", confidence: 0.2 },
    { content: "no-score" }, // unscored — must never be silently dropped
  ];
  it("chunkScore reads confidence/score/_score; topRetrievalScore takes the max", () => {
    expect(chunkScore({ confidence: 0.7 })).toBe(0.7);
    expect(chunkScore({ score: 0.4 })).toBe(0.4);
    expect(chunkScore("string")).toBeUndefined();
    expect(topRetrievalScore(chunks)).toBe(0.9);
  });
  it("drops chunks BELOW minScore, keeps >=minScore and unscored", () => {
    const kept = filterByScore(chunks, 0.5) as Array<Record<string, unknown>>;
    expect(kept.map((k) => k.content)).toEqual(["on-topic", "no-score"]); // weak (0.2) dropped
  });
  it("minScore <= 0 disables the gate (returns all)", () => {
    expect(filterByScore(chunks, 0)).toHaveLength(3);
  });
});

describe("replySeat — relevance gate wired through", () => {
  const memory: MemoryLike = {
    async assembleContext() {
      return { retrieval: [{ content: "relevant", confidence: 0.9 }, { content: "noise", confidence: 0.1 }] };
    },
  };
  it("with a threshold, weak chunks never reach the prompt; meta reports raw vs kept", async () => {
    let seen = "";
    const gen = async (_s: string, user: string) => { seen = user; return "ok"; };
    const env = await replySeat(stubNeop, { message: "q" }, { gen, memory }, { minScore: 0.5 });
    expect(seen).toContain("relevant");
    expect(seen).not.toContain("noise"); // gated out of the context
    expect(env.meta?.retrievalCount).toBe(2); // raw
    expect(env.meta?.retrievalKept).toBe(1); // survived
    expect(env.meta?.topScore).toBe(0.9);
    expect(env.meta?.minScore).toBe(0.5);
  });
  it("if all chunks are below threshold, context collapses to (no relevant memory)", async () => {
    let seen = "";
    const gen = async (_s: string, user: string) => { seen = user; return "ok"; };
    const env = await replySeat(stubNeop, { message: "q" }, { gen, memory }, { minScore: 0.95 });
    expect(seen).toContain("(no relevant memory)");
    expect(env.meta?.retrievalKept).toBe(0);
  });
});
