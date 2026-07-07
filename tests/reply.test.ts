/**
 * Component 3 (replySeat) WIRING. `memory.assembleContext` is MOCKED — it is GAP-1's box-UNPROVEN live
 * retrieval (condition B). A green here = the reply PATH is wired given retrieval; it is NOT "memory-backed
 * replies work". path-green ≠ memory-green. responds ≠ ranks. The generation is a tool-less fake.
 */
import { describe, it, expect } from "vitest";
import { replySeat, type MemoryLike } from "../src/seat/reply.ts";

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
