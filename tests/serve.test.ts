/**
 * GAP/M1b offline tests for the seat-serve entrypoint + provider selection. The LIVE run (a real NEop
 * on the box, against a live palace, via OpenRouter) is box-gated + T9-STOP-and-ask — NOT tested here.
 * What IS testable offline: the task→run-case synthesis and the D2 provider/key resolution logic.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
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
  it("maps all providers to their key env", () => {
    expect(PROVIDER_KEY_ENV.openrouter).toBe("OPENROUTER_API_KEY");
    expect(PROVIDER_KEY_ENV.anthropic).toBe("ANTHROPIC_API_KEY");
    expect(PROVIDER_KEY_ENV["amazon-bedrock"]).toBe("AWS_BEARER_TOKEN_BEDROCK"); // Decision 2
  });
  it("selects amazon-bedrock via NEOP_PROVIDER, case-insensitively", () => {
    expect(resolveProvider({ NEOP_PROVIDER: "Amazon-Bedrock" } as any)).toBe("amazon-bedrock");
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

// Bedrock (Decision 2): live-mode RESOLUTION logic is offline-testable (registryGetModel is a pure Map lookup,
// no network). What is NOT here is the in-VPC generate itself (box + ap-south-1 token): resolves ≠ generates.
describe("ModelBroker live mode — amazon-bedrock provider (Decision 2, sealed spine)", () => {
  const KEYS = [
    "NEOP_PROVIDER",
    "CLASSIFIER_PROVIDER",
    "AWS_BEARER_TOKEN_BEDROCK",
    "NRT_MODEL",
    "NRT_BEDROCK_REGION",
    "AWS_REGION",
    "AWS_DEFAULT_REGION",
  ];
  let saved: Record<string, string | undefined>;
  beforeEach(() => {
    saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
    for (const k of KEYS) delete process.env[k];
    process.env.NEOP_PROVIDER = "amazon-bedrock";
  });
  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it("fails CLOSED at construction when AWS_BEARER_TOKEN_BEDROCK is blank (no fake generate path)", () => {
    expect(() => new ModelBroker("live")).toThrow(/AWS_BEARER_TOKEN_BEDROCK/);
  });

  it("with a bearer set, resolves the Nova model and stamps the apac.* inference profile onto model.id", () => {
    process.env.AWS_BEARER_TOKEN_BEDROCK = "bedrock-api-key-TEST";
    const b = new ModelBroker("live");
    // The registry holds the BARE id; the broker stamps the regional profile the on-demand invoke needs.
    expect((b.getModel() as any).id).toBe("apac.amazon.nova-lite-v1:0");
    b.dispose();
  });

  it("pins the spine region (ap-south-1) when the operator has set none — the token is region-scoped", () => {
    process.env.AWS_BEARER_TOKEN_BEDROCK = "bedrock-api-key-TEST";
    const b = new ModelBroker("live");
    expect(process.env.AWS_REGION).toBe("ap-south-1");
    expect(process.env.AWS_DEFAULT_REGION).toBe("ap-south-1");
    b.dispose();
  });

  it("honors an operator-chosen region over the default", () => {
    process.env.AWS_BEARER_TOKEN_BEDROCK = "bedrock-api-key-TEST";
    process.env.NRT_BEDROCK_REGION = "ap-southeast-2";
    const b = new ModelBroker("live");
    expect(process.env.AWS_REGION).toBe("ap-southeast-2");
    b.dispose();
  });

  it("falls back to the nova shell and stamps an id not in pi-ai's registry (verbatim Converse modelId)", () => {
    // pi-ai sends model.id verbatim as the Converse modelId and its registry lags new bedrock ids (e.g. newer
    // Claude profiles). So an unknown id no longer throws here — it rides the nova shell with the id stamped,
    // and Bedrock itself rejects a truly bogus id at invoke time. This is what lets the Claude ids work.
    process.env.AWS_BEARER_TOKEN_BEDROCK = "bedrock-api-key-TEST";
    process.env.NRT_MODEL = "apac.amazon.nonesuch-v9:9";
    const b = new ModelBroker("live");
    expect((b.getModel() as any).id).toBe("apac.amazon.nonesuch-v9:9");
    b.dispose();
  });

  it("resolves a Claude bedrock profile id (not in the bare registry) by stamping it onto the shell", () => {
    process.env.AWS_BEARER_TOKEN_BEDROCK = "bedrock-api-key-TEST";
    process.env.NRT_MODEL = "global.anthropic.claude-sonnet-4-5-20250929-v1:0";
    const b = new ModelBroker("live");
    expect((b.getModel() as any).id).toBe("global.anthropic.claude-sonnet-4-5-20250929-v1:0");
    b.dispose();
  });

  it("a per-broker modelIdOverride wins over NRT_MODEL, and two brokers do NOT clobber each other's id", () => {
    process.env.AWS_BEARER_TOKEN_BEDROCK = "bedrock-api-key-TEST";
    process.env.NRT_MODEL = "apac.amazon.nova-lite-v1:0";
    const fast = new ModelBroker("live", "global.anthropic.claude-haiku-4-5-20251001-v1:0");
    const quality = new ModelBroker("live", "global.anthropic.claude-sonnet-4-5-20250929-v1:0");
    // The clone in resolveBedrockModel keeps them independent — no shared-registry-object clobber.
    expect((fast.getModel() as any).id).toBe("global.anthropic.claude-haiku-4-5-20251001-v1:0");
    expect((quality.getModel() as any).id).toBe("global.anthropic.claude-sonnet-4-5-20250929-v1:0");
    fast.dispose();
    quality.dispose();
  });
});
