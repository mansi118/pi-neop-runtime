/**
 * END-TO-END: POST /seat/verdict → the REAL seat HTTP server → REAL MemoryBroker (live) → REAL
 * PalaceClient (scope baked, allowlist enforced, X-Palace-Neop header) → a LOCAL /mcp palace stub that
 * mirrors the Mempalace contract for palace_put_run_event/palace_get_run_events (in-memory run_events).
 *
 * This exercises the whole wrapper verdict path over real HTTP + real auth; the palace's REAL behaviour
 * (the Convex run_events tool) is separately proven by the palace convex-test suite (Mempalace #31). So
 * the composition — this e2e + that suite — proves the chain end to end without a deployed palace.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { serveTurn, type SeatHandlers } from "../src/seat/wrapper.ts";
import { MemoryBroker } from "../src/brokers/memory.ts";
import { PalaceClient } from "../src/brokers/palaceClient.ts";
import { makeVerdictHandler } from "../src/seat/verdict.ts";

// ── a faithful local /mcp palace stub (in-memory run_events, own-seat keyed) ──────────────────────────
function startPalaceStub(): Promise<{ url: string; store: Map<string, any[]>; server: http.Server }> {
  const store = new Map<string, any[]>(); // key `${palaceId}:${neopId}` -> [event...]
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c as Buffer));
    req.on("end", () => {
      const reply = (status: number, body: unknown) => {
        const data = Buffer.from(JSON.stringify(body), "utf8");
        res.writeHead(status, { "Content-Type": "application/json", "Content-Length": data.length });
        res.end(data);
      };
      let b: any;
      try { b = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { return reply(400, { error: "bad json" }); }
      const key = `${b.palaceId}:${b.neopId}`; // server derives scope from the envelope, like real /mcp
      if (b.tool === "palace_put_run_event") {
        const arr = store.get(key) ?? [];
        arr.push(b.params?.event);
        store.set(key, arr);
        return reply(200, { status: "ok", data: { status: "ok", upsert: "insert", trimmed: 0 } });
      }
      if (b.tool === "palace_get_run_events") {
        const arr = (store.get(key) ?? []).slice().reverse(); // newest-first, like the real tool
        return reply(200, { status: "ok", data: { events: arr, count: arr.length } });
      }
      return reply(200, { status: "error", error: `unexpected tool ${b.tool}` });
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as AddressInfo).port;
      resolve({ url: `http://127.0.0.1:${port}`, store, server });
    });
  });
}

async function post(url: string, token: string | undefined, body: unknown) {
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
  let json: any = {};
  try { json = await r.json(); } catch { /* */ }
  return { status: r.status, json };
}

describe("POST /seat/verdict e2e (server → broker → PalaceClient → palace stub)", () => {
  let palace: Awaited<ReturnType<typeof startPalaceStub>>;
  let seat: http.Server;
  let seatUrl: string;
  const TOKEN = "forward-secret";

  beforeAll(async () => {
    palace = await startPalaceStub();
    // REAL live broker, scope BAKED to (testpalace, aria), talking to the local palace stub over real HTTP.
    const broker = new MemoryBroker("live", [], undefined,
      new PalaceClient({ palaceUrl: palace.url, palaceId: "testpalace", neopId: "aria" }));
    const handlers: SeatHandlers = {
      classify: async () => { throw new Error("not used"); },
      reply: async () => { throw new Error("not used"); },
      runTask: async () => { throw new Error("not used"); },
      verdict: makeVerdictHandler({ memory: broker, neopId: "aria" }),
    };
    seat = serveTurn({ forwardToken: TOKEN, t9Ack: true }, handlers, { port: 0 });
    await new Promise<void>((r) => seat.on("listening", () => r()));
    seatUrl = `http://127.0.0.1:${(seat.address() as AddressInfo).port}/seat/verdict`;
  });

  afterAll(async () => {
    await new Promise<void>((r) => seat.close(() => r()));
    await new Promise<void>((r) => palace.server.close(() => r()));
  });

  it("an approve verdict lands in the palace run_events under (testpalace, aria) as agreed:true", async () => {
    const out = await post(seatUrl, TOKEN, { verdict: "approve", seat: "aria", proposalId: "p1" });
    expect(out.status).toBe(200);
    expect(out.json).toEqual({ status: "ok" });
    const stored = palace.store.get("testpalace:aria") ?? [];
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ kind: "human_verdict", agreed: true, proposal_id: "p1" });
    // readable back through the same contract the fidelity runner uses:
    const read = await post(palace.url, undefined, { tool: "palace_get_run_events", palaceId: "testpalace", neopId: "aria", params: {} });
    expect(read.json.data.events[0]).toMatchObject({ kind: "human_verdict", agreed: true });
  });

  it("a reject verdict persists agreed:false", async () => {
    await post(seatUrl, TOKEN, { verdict: "reject", seat: "aria" });
    const stored = palace.store.get("testpalace:aria") ?? [];
    expect(stored[stored.length - 1]).toMatchObject({ kind: "human_verdict", agreed: false });
  });

  it("a bad forward token is rejected 403 and nothing is persisted", async () => {
    const before = (palace.store.get("testpalace:aria") ?? []).length;
    const out = await post(seatUrl, "wrong", { verdict: "approve", seat: "aria" });
    expect(out.status).toBe(403);
    expect((palace.store.get("testpalace:aria") ?? []).length).toBe(before);
  });

  it("a mis-routed verdict (seat=recon) is rejected 409 and never written under aria", async () => {
    const before = (palace.store.get("testpalace:aria") ?? []).length;
    const out = await post(seatUrl, TOKEN, { verdict: "approve", seat: "recon" });
    expect(out.status).toBe(409);
    expect((palace.store.get("testpalace:aria") ?? []).length).toBe(before);
    expect(palace.store.get("testpalace:recon")).toBeUndefined(); // never wrote another seat's row
  });
});
