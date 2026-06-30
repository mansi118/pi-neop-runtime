/**
 * GAP-1 offline tests — the pure /mcp security core, ported 1:1 from the Python shim's red-team
 * battery (neop_jcode_adapter/tests/test_redteam_isolation.py). No network: buildRequest + guards are
 * exercised directly, and live-mode MemoryBroker is driven through an injected mock transport.
 *
 * These are the offline-gradeable half of GAP-1. The LIVE half (ranked retrieval matching 0.986) is
 * box-gated — see tools/gap1_live_proof.ts. Green here ≠ GAP-1 done; GAP-1 is done at the live proof.
 */

import { describe, it, expect } from "vitest";
import { randomBytes } from "node:crypto";
import {
  PalaceClient,
  ScopeNotConfigured,
  ToolRejected,
  ScopeSpoofRejected,
  Ed25519Signer,
  type Transport,
} from "../src/brokers/palaceClient.ts";
import { MemoryBroker } from "../src/brokers/memory.ts";

const BASE = { palaceUrl: "https://x.convex.site/mcp", palaceId: "pal_1", neopId: "seat_1" };

describe("scope fail-closed (blank → refuse; would default to _admin server-side)", () => {
  it("refuses blank palaceUrl/palaceId/neopId", () => {
    expect(() => new PalaceClient({ ...BASE, palaceUrl: "" })).toThrow(ScopeNotConfigured);
    expect(() => new PalaceClient({ ...BASE, palaceId: "  " })).toThrow(ScopeNotConfigured);
    expect(() => new PalaceClient({ ...BASE, neopId: "" })).toThrow(ScopeNotConfigured);
  });
  it("refuses an EXPLICIT privileged identity on seat OR palace", () => {
    for (const id of ["_admin", "_system"]) {
      expect(() => new PalaceClient({ ...BASE, neopId: id })).toThrow(/reserved privileged/);
      expect(() => new PalaceClient({ ...BASE, palaceId: id })).toThrow(/reserved privileged/);
    }
  });
});

describe("tool allowlist", () => {
  it("rejects a non-allowlisted tool", () => {
    const c = new PalaceClient(BASE);
    expect(() => c.buildRequest("palace_delete_everything")).toThrow(ToolRejected);
    expect(() => c.buildRequest("palace_get_closet")).toThrow(ToolRejected); // gated off by default
  });
  it("allows the base tools, and get_closet only when enabled", () => {
    expect(() => new PalaceClient(BASE).buildRequest("palace_search", { query: "q" })).not.toThrow();
    const gated = new PalaceClient({ ...BASE, enableGetCloset: true });
    expect(() => gated.buildRequest("palace_get_closet", { closetId: "c1" })).not.toThrow();
  });
});

describe("scope is baked from env, never from the model", () => {
  it("bakes palaceId/neopId into the body and the X-Palace-Neop header", () => {
    const { body, headers } = new PalaceClient(BASE).buildRequest("palace_search", { query: "hi" });
    expect(body).toEqual({
      tool: "palace_search",
      palaceId: "pal_1",
      neopId: "seat_1",
      params: { query: "hi" },
    });
    expect(headers["X-Palace-Neop"]).toBe("seat_1");
  });
  it("rejects model-supplied scope/envelope keys loudly (no silent drop)", () => {
    const c = new PalaceClient(BASE);
    for (const k of ["palaceId", "neopId", "tool", "params"]) {
      expect(() => c.buildRequest("palace_search", { query: "q", [k]: "evil" })).toThrow(
        ScopeSpoofRejected,
      );
    }
  });
  it("a smuggled neopId cannot override the baked seat", () => {
    const c = new PalaceClient(BASE);
    expect(() => c.buildRequest("palace_search", { neopId: "_admin", query: "q" })).toThrow(
      ScopeSpoofRejected,
    );
  });
});

describe("Ed25519 signing (forward-looking, optional)", () => {
  it("adds signature + raw pubkey headers only when a key ref is configured", () => {
    const seedB64 = randomBytes(32).toString("base64");
    process.env.__TEST_SEED = seedB64;
    const signed = new PalaceClient({ ...BASE, signingKeyRef: "env:__TEST_SEED" });
    const { headers } = signed.buildRequest("palace_search", { query: "q" });
    expect(headers["X-NEop-Signature"]).toMatch(/^[A-Za-z0-9+/]+=*$/);
    expect(Buffer.from(headers["X-NEop-Pubkey"], "base64")).toHaveLength(32);
    delete process.env.__TEST_SEED;
    // unsigned client adds neither
    const { headers: h2 } = new PalaceClient(BASE).buildRequest("palace_search", { query: "q" });
    expect(h2["X-NEop-Signature"]).toBeUndefined();
  });
  it("signer round-trips a deterministic 32-byte seed", () => {
    const s = new Ed25519Signer(Buffer.alloc(32, 7));
    expect(Buffer.from(s.publicKeyB64, "base64")).toHaveLength(32);
    expect(s.sign(Buffer.from("msg"))).toMatch(/^[A-Za-z0-9+/]+=*$/);
  });
});

describe("call() envelope parsing", () => {
  const okSearch: Transport = async (_u, body, headers) => {
    // assert the wire contract the way Mempalace /mcp expects it
    expect((body as any).tool).toBe("palace_search");
    expect((body as any).palaceId).toBe("pal_1");
    expect(headers["X-Palace-Neop"]).toBe("seat_1");
    return { status: 200, json: { status: "ok", data: { results: [{ id: "r1", score: 0.986 }] } } };
  };
  it("marks ok only on http 200 + body.status ok", async () => {
    const c = new PalaceClient({ ...BASE, transport: okSearch });
    const r = await c.call("palace_search", { query: "q" });
    expect(r.ok).toBe(true);
    expect(r.response.data.results[0].score).toBe(0.986);
  });
  it("ok=false on a 403 ACL denial", async () => {
    const deny: Transport = async () => ({ status: 403, json: { status: "error", error: "denied" } });
    const r = await new PalaceClient({ ...BASE, transport: deny }).call("palace_search", { query: "q" });
    expect(r.ok).toBe(false);
    expect(r.httpStatus).toBe(403);
  });
});

describe("MemoryBroker live mode (injected transport)", () => {
  it("retrieve → palace_search, returns data.results", async () => {
    const t: Transport = async () => ({
      status: 200,
      json: { status: "ok", data: { results: [{ id: "c1", score: 0.91 }] } },
    });
    const m = new MemoryBroker("live", [], undefined, new PalaceClient({ ...BASE, transport: t }));
    const hits = await m.retrieve("the pangolin came home", 5);
    expect(hits).toEqual([{ id: "c1", score: 0.91 }]);
  });
  it("retrieve THROWS on contract failure (no graceful-empty masquerade)", async () => {
    const t: Transport = async () => ({ status: 500, json: { status: "error", error: "boom" } });
    const m = new MemoryBroker("live", [], undefined, new PalaceClient({ ...BASE, transport: t }));
    await expect(m.retrieve("q")).rejects.toThrow(/palace_search failed: http 500/);
  });
  it("retrieve returns [] on ok-but-empty (proof decides empty=FAIL, not the broker)", async () => {
    const t: Transport = async () => ({ status: 200, json: { status: "ok", data: { results: [] } } });
    const m = new MemoryBroker("live", [], undefined, new PalaceClient({ ...BASE, transport: t }));
    expect(await m.retrieve("q")).toEqual([]);
  });
  it("write → palace_remember with content", async () => {
    let seen: any = null;
    const t: Transport = async (_u, body) => {
      seen = body;
      return { status: 200, json: { status: "ok", data: { closetId: "c9" } } };
    };
    const m = new MemoryBroker("live", [], undefined, new PalaceClient({ ...BASE, transport: t }));
    await m.write({ content: "remember this", wingName: "ops" });
    expect(seen.tool).toBe("palace_remember");
    expect(seen.params).toEqual({ content: "remember this", wingName: "ops" });
  });
  it("unit mode is unchanged: fixture STM + no-op writes", async () => {
    const m = new MemoryBroker("unit", [{ a: 1 }, { b: 2 }, { c: 3 }]);
    expect(await m.retrieve("q", 2)).toEqual([{ a: 1 }, { b: 2 }]);
    await m.write({ x: 1 });
    expect(m.writes).toEqual([{ x: 1 }]);
  });
});
