/**
 * Proof-B-composition (`nrt probe-memory`) error classification — pure, unit-testable without a live palace.
 * The memory-side twin of probeErrors: a live retrieval failure must surface as a NAMED, ATTRIBUTABLE cause
 * — ACL-denied (the seed:access gate, NOT a wiring bug) · egress/dns · scope-misconfigured · palace-5xx —
 * so a memory failure is disambiguated from the palace itself (which ranked_retrieval_proof.py proves green).
 * That attribution is the whole reason this probe exists: green palace + Hermes-composition never isolated =
 * a future memory failure you can't place. Kept out of cli.ts (which runs main() on import) for testability.
 */
export function classifyMemoryProbeError(msg: string): string {
  const m = msg.toLowerCase();
  // SCOPE first — a construction-time fail-closed (blank/reserved PALACE_ID/NEOP_ID) is not a live failure.
  if (/is blank|reserved privileged|scopenotconfigured|palace_mcp_url.*blank|neop_id.*blank|palace_id.*blank/.test(m))
    return "SCOPE: PALACE_ID/NEOP_ID/PALACE_MCP_URL blank or a reserved identity — fail-closed at construction (never defaults to _admin). Set the seat scope from env.";
  if (/http 403|forbidden|\bdenied\b|not permissioned|acl/.test(m))
    return "ACL-DENIED (403): the seat is not permissioned for recall — needs the seed:access grant (the ML gate), NOT a wiring bug. This is expected on an unseeded seat.";
  if (/enotfound|econnrefused|etimedout|timeout|fetch failed|network|getaddrinfo|socket hang/.test(m))
    return "EGRESS/DNS: could not reach the palace /mcp endpoint — check PALACE_MCP_URL and that the wrapper SG reaches Convex (internal, in-VPC).";
  if (/http 5\d\d|status.*error|internal server|bad gateway|service unavailable/.test(m))
    return "PALACE-ERROR (5xx): the palace /mcp returned a server error — check the Convex /mcp deployment, not the Hermes path.";
  return `UNCLASSIFIED: ${msg.slice(0, 300)}`;
}
