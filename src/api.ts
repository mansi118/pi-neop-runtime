/**
 * Runtime API — dispatch (§2.1). The loader runs here so a bad definition becomes
 * a REJECTED outcome before a supervisor is created.
 */

import { load } from "./loader.ts";
import { FrontmatterError } from "./schema.ts";
import { SessionSupervisor } from "./supervisor.ts";
import type { RunResult } from "./supervisor.ts";
import type { Mode } from "./brokers/model.ts";
import { Trace, persist } from "./trace.ts";

export async function dispatch(neopPath: string, testCase: any, mode: Mode = "unit"): Promise<RunResult> {
  let neop;
  try {
    neop = load(neopPath);
  } catch (e) {
    if (e instanceof FrontmatterError) {
      const tr = new Trace("run_rejected", neopPath, testCase.case_id ?? "?");
      tr.recordTransition("LOADING", "REJECTED");
      persist(tr);
      return {
        runId: tr.runId,
        neop: neopPath,
        caseId: testCase.case_id ?? "?",
        terminalState: "REJECTED",
        plan: null,
        taskOutcomes: [],
        replansPerformed: 0,
        trace: tr,
        error: String(e),
        acceptanceAllPass: false,
      };
    }
    throw e;
  }

  const supervisor = new SessionSupervisor(neop, testCase, mode);
  const result = await supervisor.run();
  persist(result.trace);
  return result;
}
