/**
 * Proof-A (`nrt probe-model`) error classification — pure, so it is unit-testable without a live model.
 * A live-model failure must surface as a NAMED, diagnosable cause (auth/region · egress/dns · model-not-
 * granted), not a generic stack trace — the model-egress-thread lesson. Kept out of cli.ts (which runs
 * main() on import) so tests can import it without booting the CLI.
 */
export function classifyProbeError(msg: string): string {
  const m = msg.toLowerCase();
  // MODEL-access first: it is the MORE SPECIFIC case and its phrasings ("not authorized to invoke this
  // model") overlap the generic auth strings — so it must win before the 403/auth catch-all below.
  if (/access.*model|not.*grant|invoke.*permission|invoke this model|not authorized to invoke|inference profile|on-demand throughput/.test(m))
    return "MODEL-NOT-GRANTED: the account/profile can't invoke this model id — confirm apac.amazon.nova-lite-v1:0 (the APAC inference profile; bare amazon.nova-* rejects on-demand).";
  if (/403|forbidden|unauthor|security token|invalid.*token|token.*invalid|not authorized/.test(m))
    return "AUTH/REGION (403): bearer invalid or region-mismatched — a us-east-1 token 403s in ap-south-1. Check AWS_BEARER_TOKEN_BEDROCK is ap-south-1-scoped.";
  if (/region|endpoint.*resolve|different region/.test(m))
    return "REGION: the request targeted the wrong region — the broker pins ap-south-1; confirm the bearer matches.";
  if (/enotfound|econnrefused|etimedout|timeout|fetch failed|network|getaddrinfo|socket hang/.test(m))
    return "EGRESS/DNS: could not reach bedrock-runtime.ap-south-1.amazonaws.com — the jail allowlist (#97) must permit it AND the PrivateLink private-DNS must resolve it. host-in-map ≠ connection-succeeds.";
  return `UNCLASSIFIED: ${msg.slice(0, 300)}`;
}
