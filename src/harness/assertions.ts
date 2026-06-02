/** Assertion engine — grades a RunResult against a fixture's expectations (§4.4). */

import type { NeopDefinition } from "../loader.ts";
import type { RunResult } from "../supervisor.ts";
import { structuralDiff } from "../plan.ts";
import { loadGolden } from "./fixtures.ts";

export interface CheckResult {
  name: string;
  passed: boolean;
  detail: string;
}

export class CaseReport {
  caseId: string;
  neop: string;
  runId: string;
  checks: CheckResult[] = [];
  constructor(caseId: string, neop: string, runId: string) {
    this.caseId = caseId;
    this.neop = neop;
    this.runId = runId;
  }
  get passed(): boolean {
    return this.checks.every((c) => c.passed);
  }
  add(name: string, passed: boolean, detail = ""): void {
    this.checks.push({ name, passed, detail });
  }
}

export function assertCase(neop: NeopDefinition, testCase: any, result: RunResult): CaseReport {
  const expect = testCase.expect ?? {};
  const rep = new CaseReport(testCase.case_id, result.neop, result.runId);

  // 1. terminal state
  if (expect.terminal_state != null) {
    const got = result.terminalState;
    const ok = got === expect.terminal_state;
    let detail = `reached ${got}${ok ? "" : `, wanted ${expect.terminal_state}`}`;
    if (result.error && !ok) detail += ` (error: ${result.error})`;
    rep.add("terminal_state", ok, detail);
  }

  // 2. plan structure vs golden
  if (expect.golden_plan) {
    const golden = loadGolden(neop, expect.golden_plan);
    if (!golden) rep.add("plan_structure", false, `golden '${expect.golden_plan}' not found — record it`);
    else if (!result.plan) rep.add("plan_structure", false, "no plan was emitted");
    else {
      const diffs = structuralDiff(result.plan, golden);
      rep.add("plan_structure", diffs.length === 0, diffs.length ? diffs.join("; ") : "matches golden");
    }
  }

  // 3. tool allowlist
  const called = new Set(result.trace.toolCalls.map((c) => c.tool));
  const denied = new Set(result.trace.deniedTools);
  for (const t of expect.must_call_tools ?? []) rep.add(`must_call:${t}`, called.has(t), called.has(t) ? "called" : "never called");
  for (const t of expect.must_not_call_tools ?? []) rep.add(`must_not_call:${t}`, !called.has(t), called.has(t) ? "was called!" : "not called");
  for (const t of expect.must_deny_tools ?? []) rep.add(`must_deny:${t}`, denied.has(t), denied.has(t) ? "denied" : "was not denied");

  // 4. acceptance
  if ("acceptance_all_pass" in expect) {
    const want = Boolean(expect.acceptance_all_pass);
    const got = result.acceptanceAllPass;
    const fails = result.taskOutcomes.filter((o) => o.verdict !== "pass").map((o) => o.task_id);
    rep.add("acceptance", got === want, got ? "all tasks pass" : `failing tasks: [${fails}]`);
  }

  // 5. re-plan budget
  if ("max_replans" in expect) {
    const cap = Number(expect.max_replans);
    rep.add("replan_budget", result.replansPerformed <= cap, `${result.replansPerformed} replans (cap ${cap})`);
  }

  // 6. latency
  if ("max_latency_s" in expect) {
    const cap = Number(expect.max_latency_s);
    const total = result.trace.totalLatencyS();
    rep.add("latency", total <= cap, `${total}s (budget ${cap}s)`);
  }

  return rep;
}
