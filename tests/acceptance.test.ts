/**
 * Acceptance tests — maps 1:1 to NE-TSD-RT-V1 §6, exercised through the REAL pi
 * agent harness (planner/executor/verifier are pi Agent runs; tools execute via
 * pi's tool machinery; unit determinism comes from pi's faux provider).
 *
 * Run: npm test
 */

import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { load } from "../src/loader.ts";
import { FrontmatterError } from "../src/schema.ts";
import { dispatch } from "../src/api.ts";
import { loadCases } from "../src/harness/fixtures.ts";
import { assertCase } from "../src/harness/assertions.ts";
import { canonicalBytes, structuralDiff, planFromObj } from "../src/plan.ts";
import { assertTransition, IllegalTransition } from "../src/state.ts";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const RECON = join(REPO, "agents", "recon");
const OUTREACH = join(REPO, "agents", "outreach");
const BROKEN = join(REPO, "examples", "broken-neop");

const caseById = (neopPath: string, id: string) =>
  loadCases(load(neopPath)).find((c) => c.case_id === id)!;

async function run(neopPath: string, id: string) {
  const nd = load(neopPath);
  const testCase = caseById(neopPath, id);
  const result = await dispatch(neopPath, testCase, "unit");
  return { nd, testCase, result };
}

describe("§6 acceptance — on the pi harness", () => {
  // Criterion 1
  it("c1: a broken definition fails loud with a NAMED error", () => {
    expect(() => load(BROKEN)).toThrowError(FrontmatterError);
    try {
      load(BROKEN);
    } catch (e) {
      expect((e as Error).message).toContain("role_family");
    }
  });

  it("c1: a good definition loads", () => {
    const nd = load(RECON);
    expect(nd.neopId).toBe("recon");
    expect(nd.allow).toContain("browser_agent");
  });

  // Criterion 2
  it("c2: a Pi-agent runs plan->execute->verify to DONE", async () => {
    const { nd, testCase, result } = await run(RECON, "recon_delhi_agencies");
    expect(result.terminalState).toBe("DONE");
    const rep = assertCase(nd, testCase, result);
    expect(rep.passed, rep.checks.filter((c) => !c.passed).map((c) => `${c.name}:${c.detail}`).join("; ")).toBe(true);
  });

  // Criterion 3
  it("c3: unit mode is deterministic (identical plan x3)", async () => {
    const sigs = new Set<string>();
    for (let i = 0; i < 3; i++) {
      const r = await dispatch(RECON, caseById(RECON, "recon_delhi_agencies"), "unit");
      sigs.add(canonicalBytes(r.plan!));
    }
    expect(sigs.size).toBe(1);
  });

  // Criterion 4
  it("c4: golden-plan structural diff catches a plan change", async () => {
    const r = await dispatch(RECON, caseById(RECON, "recon_delhi_agencies"), "unit");
    const drifted = planFromObj(JSON.parse(JSON.stringify(r.plan)));
    drifted.tasks[0].tool = "some_other_tool";
    expect(structuralDiff(r.plan!, drifted).length).toBeGreaterThan(0);
    expect(structuralDiff(r.plan!, planFromObj(JSON.parse(JSON.stringify(r.plan)))).length).toBe(0);
  });

  // Criterion 5
  it("c5: the allowlist denies a forbidden tool; must_not_call never fires", async () => {
    const { nd, testCase, result } = await run(RECON, "recon_forbidden_tool");
    expect(result.trace.deniedTools).toContain("send_email");
    expect(result.trace.toolCalls.map((c) => c.tool)).not.toContain("send_email");
    expect(assertCase(nd, testCase, result).passed).toBe(true);
  });

  // Criterion 6
  it("c6: re-plan + escalate path works", async () => {
    const { nd, testCase, result } = await run(RECON, "recon_escalate_always_fail");
    expect(result.terminalState).toBe("ESCALATED");
    expect(result.replansPerformed).toBe(nd.maxReplans);
    expect(assertCase(nd, testCase, result).passed).toBe(true);
  });

  // Approval path (state machine §2.2)
  it("approval grant reaches DONE through AWAITING_APPROVAL", async () => {
    const { nd, testCase, result } = await run(OUTREACH, "outreach_send_grant");
    expect(result.terminalState).toBe("DONE");
    expect(result.trace.transitions.join("\n")).toContain("AWAITING_APPROVAL -> EXECUTING");
    expect(assertCase(nd, testCase, result).passed).toBe(true);
  });

  it("approval deny fails before send_email fires", async () => {
    const { nd, testCase, result } = await run(OUTREACH, "outreach_send_deny");
    expect(result.terminalState).toBe("FAILED");
    expect(result.trace.toolCalls.map((c) => c.tool)).not.toContain("send_email");
    expect(assertCase(nd, testCase, result).passed).toBe(true);
  });

  // State machine guard
  it("state machine rejects an illegal transition", () => {
    expect(() => assertTransition("PLANNING", "DONE")).toThrowError(IllegalTransition);
    expect(() => assertTransition("PLANNING", "EXECUTING")).not.toThrow();
  });
});
