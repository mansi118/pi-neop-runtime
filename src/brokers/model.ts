/**
 * Model broker — the integration point with the real pi harness.
 *
 * Routes a phase to a model and records token cost (§2.1). Three modes (§4.1):
 *   unit        -> pi's `faux` provider replays recorded cassettes (deterministic, no spend)
 *   integration -> live model, mock tools
 *   live        -> live model, real tools
 *
 * §8 "Recorded-stub format": per-case JSON cassette at
 * `<neop>/fixtures/cassettes/<case_id>.json`, keyed by phase. The broker turns a
 * cassette into a queue of faux assistant messages the pi Agent consumes.
 */

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import {
  type FauxResponseStep,
  type Model,
  fauxAssistantMessage,
  fauxToolCall,
  getModel as registryGetModel,
  registerFauxProvider,
} from "@earendil-works/pi-ai";
import type { NeopDefinition } from "../loader.ts";
import { deterministicPlanId } from "../plan.ts";
import type { Task } from "../plan.ts";

export class CassetteMissing extends Error {}

let FAUX_SEQ = 0;

export type Mode = "unit" | "integration" | "live";

export class ModelBroker {
  mode: Mode;
  private fauxReg?: ReturnType<typeof registerFauxProvider>;
  private model: Model<any>;

  constructor(mode: Mode) {
    this.mode = mode;
    if (mode === "unit") {
      const id = `faux-neop-${FAUX_SEQ++}`;
      this.fauxReg = registerFauxProvider({ api: id, provider: id, models: [{ id: "faux-1" }] });
      this.model = this.fauxReg.getModel();
    } else {
      // integration/live: resolve a concrete model from the pi-ai registry.
      this.model = this.resolveLiveModel();
    }
  }

  getModel(): Model<any> {
    return this.model;
  }

  /** Load the next queue of faux responses (unit mode only; no-op otherwise). */
  program(steps: FauxResponseStep[]): void {
    if (this.mode === "unit" && steps.length) this.fauxReg?.setResponses(steps);
  }

  getApiKey = (_provider: string): string => {
    return this.mode === "unit" ? "faux-key" : process.env.ANTHROPIC_API_KEY ?? "";
  };

  dispose(): void {
    this.fauxReg?.unregister();
  }

  private cassettePath(neop: NeopDefinition, caseId: string): string {
    return join(neop.fixturesDir, "cassettes", `${caseId}.json`);
  }

  private loadCassette(neop: NeopDefinition, caseId: string): any {
    const p = this.cassettePath(neop, caseId);
    if (!existsSync(p)) {
      throw new CassetteMissing(
        `no recorded cassette for case '${caseId}' at ${p} — record one against a live model first`,
      );
    }
    return JSON.parse(readFileSync(p, "utf8"));
  }

  // ---- phase: PLANNING --------------------------------------------------
  /** Program the faux model to emit this case's plan as the planner's reply. */
  planResponses(neop: NeopDefinition, caseId: string, attempt: number): FauxResponseStep[] {
    if (this.mode !== "unit") return []; // live model decides
    const cass = this.loadCassette(neop, caseId);
    const replans: any[] = cass.replans ?? [];
    const planObj = attempt > 0 && attempt - 1 < replans.length ? replans[attempt - 1] : cass.plan;
    return [fauxAssistantMessage(JSON.stringify(planObj))];
  }

  stampPlan(neop: NeopDefinition, caseId: string, raw: any): any {
    const plan = { ...raw };
    plan.plan_version = plan.plan_version ?? "v1";
    plan.neop = neop.neopId;
    plan.plan_id = deterministicPlanId(neop.neopId, caseId);
    plan.max_replans = plan.max_replans ?? neop.maxReplans;
    return plan;
  }

  // ---- phase: EXECUTING -------------------------------------------------
  /** Program the faux model to call the task's tool with deterministic args, then finish. */
  executeResponses(task: Task, args: Record<string, unknown>): FauxResponseStep[] {
    if (this.mode !== "unit") return [];
    return [
      fauxAssistantMessage([fauxToolCall(task.tool!, args)]),
      fauxAssistantMessage(`executed ${task.task_id}`),
    ];
  }

  // ---- phase: VERIFYING -------------------------------------------------
  verifyResponses(neop: NeopDefinition, caseId: string, task: Task, attempt: number): FauxResponseStep[] {
    if (this.mode !== "unit") return [];
    const cass = this.loadCassette(neop, caseId);
    const verify = cass.verify ?? {};
    let v = verify[task.task_id] ?? verify.__default__ ?? "pass";
    if (Array.isArray(v)) v = v[Math.min(attempt, v.length - 1)] ?? "pass";
    const verdict = String(v).toLowerCase().startsWith("p") ? "pass" : "fail";
    const reason = verdict === "pass" ? "acceptance satisfied" : "acceptance not met (recorded)";
    return [fauxAssistantMessage(JSON.stringify({ verdict, reason }))];
  }

  private resolveLiveModel(): Model<any> {
    const alias = "claude-sonnet-4-6";
    try {
      return registryGetModel("anthropic" as any, alias as any) as Model<any>;
    } catch {
      throw new Error(
        "integration/live mode needs a resolvable model + ANTHROPIC_API_KEY; unit mode needs neither.",
      );
    }
  }
}
