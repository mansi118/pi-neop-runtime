/**
 * Proof-B-composition probe (`nrt probe-memory`) — the OFFLINE-gradeable part is the error CLASSIFIER: a live
 * retrieval failure must be ATTRIBUTABLE (ACL-denied = the seed:access gate, not a wiring bug · egress/dns ·
 * scope-misconfigured · palace-5xx), so a memory failure is disambiguated from the palace itself. The retrieval
 * itself is box-only (palace + permissioned seat) and is NOT tested here. palace-ranks ≠ Hermes-composes.
 */
import { describe, it, expect } from "vitest";
import { classifyMemoryProbeError } from "../src/seat/memoryProbeErrors.ts";

describe("classifyMemoryProbeError — a retrieval failure becomes an attributable cause", () => {
  it("http 403 / denied → ACL-DENIED (the seed:access gate, NOT a wiring bug)", () => {
    expect(classifyMemoryProbeError("palace_search failed: http 403 {\"error\":\"forbidden\"}")).toMatch(/ACL-DENIED/);
    expect(classifyMemoryProbeError("palace_search failed: http 403")).toContain("seed:access");
  });

  it("scope fail-closed (blank/reserved) → SCOPE, distinguished from a live failure", () => {
    expect(classifyMemoryProbeError("PALACE_ID is blank")).toMatch(/SCOPE/);
    expect(classifyMemoryProbeError("NEOP_ID '_admin' is a reserved privileged identity")).toMatch(/SCOPE/);
    expect(classifyMemoryProbeError("PALACE_MCP_URL is blank")).toMatch(/SCOPE/);
  });

  it("network / DNS failures → EGRESS/DNS (the SG-reach-to-Convex path)", () => {
    for (const e of ["getaddrinfo ENOTFOUND small-dogfish.convex.site", "fetch failed", "ETIMEDOUT", "ECONNREFUSED"]) {
      expect(classifyMemoryProbeError(e)).toMatch(/EGRESS\/DNS/);
    }
  });

  it("http 5xx → PALACE-ERROR (the Convex /mcp side, not the Hermes path)", () => {
    expect(classifyMemoryProbeError("palace_search failed: http 500 internal server error")).toMatch(/PALACE-ERROR/);
    expect(classifyMemoryProbeError("palace_search failed: http 503")).toMatch(/PALACE-ERROR/);
  });

  it("a 403 is NOT misread as scope or palace-error (ordering)", () => {
    // 403 must land on ACL-DENIED, not SCOPE (blank) nor PALACE-ERROR (5xx) — the seed:access gate is distinct.
    const out = classifyMemoryProbeError("palace_search failed: http 403 acl denied");
    expect(out).toMatch(/ACL-DENIED/);
    expect(out).not.toMatch(/SCOPE|PALACE-ERROR/);
  });

  it("anything unrecognized → UNCLASSIFIED (never silently swallowed), truncated", () => {
    const out = classifyMemoryProbeError("some novel palace failure " + "y".repeat(500));
    expect(out).toMatch(/^UNCLASSIFIED:/);
    expect(out.length).toBeLessThan(340);
  });
});
