/**
 * Proof-A probe (`nrt probe-model`) — the OFFLINE-gradeable part is the error CLASSIFIER: a live-model
 * failure must surface as a NAMED, diagnosable cause (auth/region · egress/dns · model-not-granted), not a
 * generic stack trace — the model-egress-thread lesson. The generate itself is box-only (needs the bearer +
 * PrivateLink reach) and is NOT tested here. resolves ≠ generates; this file proves the diagnosis, not the call.
 */
import { describe, it, expect } from "vitest";
import { classifyProbeError } from "../src/seat/probeErrors.ts";

describe("classifyProbeError — a failure becomes a named cause the operator can act on", () => {
  it("403 / unauthorized → AUTH/REGION (the region-scoped-token trap)", () => {
    expect(classifyProbeError("HTTP 403 Forbidden")).toMatch(/AUTH\/REGION/);
    expect(classifyProbeError("The security token is invalid or not authorized")).toMatch(/AUTH\/REGION/);
    expect(classifyProbeError("403")).toContain("ap-south-1");
  });

  it("network / DNS failures → EGRESS/DNS (the jail-allowlist / PrivateLink path)", () => {
    for (const e of ["getaddrinfo ENOTFOUND bedrock-runtime.ap-south-1.amazonaws.com", "fetch failed", "ETIMEDOUT", "ECONNREFUSED", "socket hang up"]) {
      expect(classifyProbeError(e)).toMatch(/EGRESS\/DNS/);
    }
    expect(classifyProbeError("fetch failed")).toContain("host-in-map ≠ connection-succeeds");
  });

  it("model access / invoke permission → MODEL-NOT-GRANTED (the apac.* profile nuance)", () => {
    expect(classifyProbeError("You are not authorized to invoke this model")).toMatch(/MODEL-NOT-GRANTED/);
    expect(classifyProbeError("Invocation with on-demand throughput isn't supported; use an inference profile")).toMatch(/MODEL-NOT-GRANTED/);
    expect(classifyProbeError("access to model is not granted")).toContain("apac.amazon.nova-lite");
  });

  it("region-mismatch phrasing → REGION", () => {
    expect(classifyProbeError("credential is for a different region")).toMatch(/REGION/);
  });

  it("anything unrecognized → UNCLASSIFIED (never silently swallowed), truncated", () => {
    const out = classifyProbeError("some totally novel failure mode " + "x".repeat(500));
    expect(out).toMatch(/^UNCLASSIFIED:/);
    expect(out.length).toBeLessThan(340);
  });
});
