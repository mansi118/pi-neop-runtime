/**
 * GAP/M1b offline tests for the seat-serve entrypoint + provider selection. The LIVE run (a real NEop
 * on the box, against a live palace, via OpenRouter) is box-gated + T9-STOP-and-ask — NOT tested here.
 * What IS testable offline: the task→run-case synthesis and the D2 provider/key resolution logic.
 */

import { describe, it, expect } from "vitest";
import { buildRunCase } from "../src/serve.ts";
import { resolveProvider, PROVIDER_KEY_ENV, ModelBroker } from "../src/brokers/model.ts";

describe("buildRunCase — real task → supervisor run-case", () => {
  it("refuses an empty objective (no NEop runs on nothing)", () => {
    expect(() => buildRunCase({ task: "" }, 1)).toThrow(/empty/i);
    expect(() => buildRunCase({ task: "   " }, 1)).toThrow(/empty/i);
  });
  it("synthesizes the case shape the supervisor consumes", () => {
    const c = buildRunCase({ task: "  draft the Q3 board update  " }, 1717000000000);
    expect(c).toEqual({
      case_id: "live-1717000000000",
      input: { text: "draft the Q3 board update" }, // trimmed
      stm: [],
      seed_twin: undefined,
      approvals: "grant", // default
    });
  });
  it("passes through caseId / stm / seedTwin / approvals", () => {
    const c = buildRunCase(
      { task: "x", caseId: "c1", stm: [{ a: 1 }], seedTwin: "twin-pre", approvals: "deny" },
      0,
    );
    expect(c.case_id).toBe("c1");
    expect(c.stm).toEqual([{ a: 1 }]);
    expect(c.seed_twin).toBe("twin-pre");
    expect(c.approvals).toBe("deny");
  });
});

describe("resolveProvider — D2 provider selection (OpenRouter primary)", () => {
  it("defaults to openrouter when nothing is set", () => {
    expect(resolveProvider({} as NodeJS.ProcessEnv)).toBe("openrouter");
  });
  it("honors NEOP_PROVIDER, then CLASSIFIER_PROVIDER, case-insensitively", () => {
    expect(resolveProvider({ NEOP_PROVIDER: "Anthropic" } as any)).toBe("anthropic");
    expect(resolveProvider({ CLASSIFIER_PROVIDER: "OPENROUTER" } as any)).toBe("openrouter");
    expect(resolveProvider({ NEOP_PROVIDER: "anthropic", CLASSIFIER_PROVIDER: "openrouter" } as any)).toBe(
      "anthropic", // NEOP_PROVIDER wins
    );
  });
  it("maps both providers to their key env", () => {
    expect(PROVIDER_KEY_ENV.openrouter).toBe("OPENROUTER_API_KEY");
    expect(PROVIDER_KEY_ENV.anthropic).toBe("ANTHROPIC_API_KEY");
  });
});

describe("ModelBroker unit mode needs no key (live key path is box-gated)", () => {
  it("unit mode returns a faux key regardless of provider", () => {
    const b = new ModelBroker("unit");
    expect(b.getApiKey("openrouter")).toBe("faux-key");
    expect(b.getApiKey("anthropic")).toBe("faux-key");
    b.dispose();
  });
});
