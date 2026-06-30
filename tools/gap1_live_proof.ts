/**
 * GAP-1 LIVE PROOF (BOX-GATED) — the gate that turns GAP-1 from "code written" to "DONE".
 *
 * ADR-neop-runtime GAP-1: the canonical Hermes/Pi runtime must reproduce, NATIVELY, what the jcode
 * path proved at T0 — a live write→embed→ranked-retrieval round-trip against CORTEX-PALACE, where an
 * empty/low-ranked result is FAILURE (not graceful-empty success). This script is the equivalent of
 * the jcode T0 canary ("the pangolin came home"): remember a fact with distinctive tokens, then search
 * with a ZERO-LEXICAL-OVERLAP query and require the fact to come back as the top semantic hit.
 *
 * Run on the box (live palace reachable in-VPC), with scope env set:
 *   PALACE_MCP_URL, PALACE_ID, NEOP_ID  (+ optional PALACE_SIGNING_KEY_REF)
 *   node tools/gap1_live_proof.ts
 * Exit 0 = GAP-1 trigger GREEN. Nonzero = still RED. Until this exits 0 on Hermes, GAP-1 is NOT done.
 */

import { PalaceClient, palaceClientFromEnv } from "../src/brokers/palaceClient.ts";

// Bar inherited from the jcode T0 spike + embedder-as-built.md:18 (empty-but-graceful = FAILURE).
const MIN_TOP_SCORE = Number(process.env.GAP1_MIN_SCORE ?? "0.80");

// Distinctive content + a query with no shared content words → forces semantic (not lexical) match.
const STAMP = `gap1-${process.pid}`;
const FACT = `The nocturnal scaled anteater (${STAMP}) finally returned to its burrow at dusk.`;
const QUERY = "where did the pangolin go back home";

function fail(msg: string): never {
  console.error(`\x1b[31mGAP-1 LIVE PROOF: RED\x1b[0m — ${msg}`);
  process.exit(1);
}

async function main() {
  let client: PalaceClient;
  try {
    client = palaceClientFromEnv();
  } catch (e) {
    fail(`scope not configured (${e instanceof Error ? e.message : String(e)}) — set PALACE_MCP_URL/PALACE_ID/NEOP_ID on the box`);
  }

  // 1. write
  const w = await client.call("palace_remember", { content: FACT, category: "proof" });
  if (!w.ok) fail(`palace_remember not ok: http ${w.httpStatus} ${JSON.stringify(w.response).slice(0, 240)}`);
  console.log("write ok:", JSON.stringify(w.response.data ?? w.response).slice(0, 160));

  // Allow async ingestion (Nova extraction → Titan embed) to land before retrieval.
  const waitMs = Number(process.env.GAP1_INGEST_WAIT_MS ?? "8000");
  await new Promise((r) => setTimeout(r, waitMs));

  // 2. retrieve with a zero-lexical-overlap query
  const s = await client.call("palace_search", { query: QUERY, limit: 5 });
  if (!s.ok) fail(`palace_search not ok: http ${s.httpStatus} ${JSON.stringify(s.response).slice(0, 240)}`);

  const results: any[] = s.response?.data?.results ?? [];
  if (results.length === 0) fail("ranked retrieval returned EMPTY — empty is FAILURE, not success");

  const top = results[0];
  const score = Number(top.score ?? top.similarity ?? top._score ?? NaN);
  const text = JSON.stringify(top).toLowerCase();
  const hitOurFact = text.includes(STAMP.toLowerCase()) || text.includes("anteater") || text.includes("burrow");

  console.log(`top hit score=${score} matchesFact=${hitOurFact}`);
  if (!Number.isFinite(score)) fail(`top hit has no readable score field: ${JSON.stringify(top).slice(0, 200)}`);
  if (!hitOurFact) fail(`top hit is NOT the seeded fact — semantic retrieval did not surface it: ${JSON.stringify(top).slice(0, 200)}`);
  if (score < MIN_TOP_SCORE) fail(`top score ${score} < bar ${MIN_TOP_SCORE}`);

  console.log(`\x1b[32mGAP-1 LIVE PROOF: GREEN\x1b[0m — Hermes-native ranked retrieval ${score} on a zero-lexical-overlap query. The contract that hit 0.986 on jcode now runs on Hermes.`);
}

main().catch((e) => fail(e instanceof Error ? e.stack ?? e.message : String(e)));
