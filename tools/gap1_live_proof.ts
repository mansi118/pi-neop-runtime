/**
 * GAP-1 LIVE PROOF (BOX-GATED) — the gate that turns GAP-1 from "code written" to "DONE".
 *
 * ADR-neop-runtime GAP-1: the canonical Hermes/Pi runtime must reproduce, NATIVELY, the live
 * write→embed→ranked-retrieval round-trip against CORTEX-PALACE, seat-scoped (a seat recalls ITS OWN
 * memory). Seed an entity-rich fact (so extraction routes it to a real wing, not _quarantine), then
 * query a ZERO-LEXICAL-OVERLAP paraphrase and require the fact back as the TOP-RANKED hit.
 *
 * BAR (set 2026-06-30 on box evidence, ML's call): **top-ranked WITH MARGIN + non-empty.** Success =
 * the seeded fact is results[0] AND clears #2 by a clear ratio (GAP1_MARGIN, default 1.3x), non-empty,
 * with the server floor lowered so a legitimate semantic hit isn't filtered. NOT an absolute cosine: a
 * true zero-overlap paraphrase scores ~0.36 on Titan (the old "0.986" target was a mislabeled LEXICAL
 * score; a fixed cosine floor is exactly what mis-bit it). Empty / wrong-top-hit / weak-margin = FAILURE.
 *
 * Run on the box (live palace reachable in-VPC), scope env set; seat must have recall+remember:
 *   PALACE_MCP_URL, PALACE_ID, NEOP_ID  (+ optional PALACE_SIGNING_KEY_REF)
 *   node tools/gap1_live_proof.ts
 * Exit 0 = GAP-1 trigger GREEN. Nonzero = still RED. Until this exits 0 on Hermes, GAP-1 is NOT done.
 */

import { PalaceClient, palaceClientFromEnv } from "../src/brokers/palaceClient.ts";

// Lower the server floor so a marginal-but-correct semantic hit (~0.36) isn't filtered; ranking decides.
const FLOOR = Number(process.env.GAP1_FLOOR ?? "0.1");

// Entity-rich fact → extraction routes it to a REAL wing (not _quarantine). STAMP makes it unique.
const STAMP = `gap1-${process.pid}`;
const FACT = `Dr. Lena Ortiz directs Project Kestrel (${STAMP}), the edge-inference effort, from the Reykjavik laboratory.`;
// Zero-lexical-overlap paraphrase: Reykjavik≈Iceland, edge-inference≈on-device ML, directs≈leads.
const QUERY = "who leads the on-device machine learning work in Iceland";
const TARGET_TOKENS = [STAMP.toLowerCase(), "ortiz", "kestrel", "reykjavik", "edge-inference"];

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

  // 1. write (seat-scoped — lands in the seat's own namespace)
  const w = await client.call("palace_remember", { content: FACT, title: "gap1-kestrel" });
  if (!w.ok) fail(`palace_remember not ok: http ${w.httpStatus} ${JSON.stringify(w.response).slice(0, 240)}`);
  console.log("write ok:", JSON.stringify(w.response.data ?? w.response).slice(0, 200));

  // Allow async ingestion (Nova extraction → Titan embed) to land before retrieval.
  const waitMs = Number(process.env.GAP1_INGEST_WAIT_MS ?? "14000");
  await new Promise((r) => setTimeout(r, waitMs));

  // 2. retrieve with a zero-lexical-overlap query, floor lowered so a legit semantic hit isn't filtered
  const s = await client.call("palace_search", { query: QUERY, limit: 5, similarityFloor: FLOOR });
  if (!s.ok) fail(`palace_search not ok: http ${s.httpStatus} ${JSON.stringify(s.response).slice(0, 240)}`);

  const results: any[] = s.response?.data?.results ?? [];
  if (results.length === 0) fail("ranked retrieval returned EMPTY — empty is FAILURE, not success");

  const top = results[0];
  const score = Number(top.score ?? top.similarity ?? top._score ?? NaN);
  const topIsTarget = TARGET_TOKENS.some((t) => JSON.stringify(top).toLowerCase().includes(t));

  // SEPARATION: absolute cosine is meaningless on heavy paraphrase (0.36 is a STRONG Titan match on
  // zero-overlap text) — what proves recall is rank + margin. Require the #1 hit to clear #2 by a clear
  // ratio, never a fixed cosine floor (a fixed floor is exactly what mis-bit the original bar).
  const second = results[1];
  const secondScore = second ? Number(second.score ?? second.similarity ?? second._score ?? 0) : 0;
  const margin = secondScore > 0 ? score / secondScore : Infinity; // Infinity = clean sole hit
  const MARGIN_MIN = Number(process.env.GAP1_MARGIN ?? "1.3");

  console.log(`top hit score=${score} topIsTarget=${topIsTarget} margin=${margin === Infinity ? "∞" : margin.toFixed(2)}x over #2 (n=${results.length})`);
  // THE BAR (ML, 2026-06-30): correct entity ranks #1, with clear margin over #2, non-empty. No absolute floor.
  if (!topIsTarget) {
    fail(`top hit is NOT the seeded fact — the seat did not recall its own memory ranked-first: ${JSON.stringify(top).slice(0, 220)}`);
  }
  if (margin < MARGIN_MIN) {
    fail(`top hit is the seeded fact but margin ${margin.toFixed(2)}x over #2 < ${MARGIN_MIN}x — not an unambiguous #1`);
  }

  console.log(`\x1b[32mGAP-1 LIVE PROOF: GREEN\x1b[0m — Hermes-native, seat-scoped write→recall: seeded fact is the unambiguous #1 (score ${score}, ${margin === Infinity ? "sole hit" : margin.toFixed(2) + "x over #2"}) on a zero-lexical-overlap query.`);
}

main().catch((e) => fail(e instanceof Error ? e.stack ?? e.message : String(e)));
