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

// D2 (ADR-llm): runtime LLM = OpenRouter primary; a direct Anthropic key is supported if set. pi-ai knows
// both as first-class providers (OPENROUTER_API_KEY / ANTHROPIC_API_KEY). Provider chosen via
// NEOP_PROVIDER (or CLASSIFIER_PROVIDER), default OpenRouter. The concrete model id rides NRT_MODEL.
export const PROVIDER_KEY_ENV: Record<string, string> = {
  anthropic: "ANTHROPIC_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
};
const DEFAULT_PROVIDER = "openrouter";
const DEFAULT_MODEL: Record<string, string> = {
  anthropic: "claude-sonnet-4-6",
  openrouter: "anthropic/claude-haiku-4.5", // ADR-llm classifier id; box-verify it's a live pi-ai openrouter id
};

export function resolveProvider(env: NodeJS.ProcessEnv = process.env): string {
  return (env.NEOP_PROVIDER || env.CLASSIFIER_PROVIDER || DEFAULT_PROVIDER).toLowerCase();
}

export class ModelBroker {
  mode: Mode;
  private fauxReg?: ReturnType<typeof registerFauxProvider>;
  private model: Model<any>;
  private provider: string = DEFAULT_PROVIDER;

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

  getApiKey = (provider: string): string => {
    if (this.mode === "unit") return "faux-key";
    const env = PROVIDER_KEY_ENV[provider] ?? PROVIDER_KEY_ENV[this.provider] ?? "ANTHROPIC_API_KEY";
    return process.env[env] ?? "";
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
    // Provider-aware (D2): OpenRouter primary, Anthropic if NEOP_PROVIDER=anthropic. The model id rides
    // NRT_MODEL; the three Pi-subagents all run on it. (Live id validity + reachability are box-verified.)
    const provider = resolveProvider();
    if (!(provider in PROVIDER_KEY_ENV)) {
      throw new Error(`live mode: unknown provider '${provider}' (use ${Object.keys(PROVIDER_KEY_ENV).join(" | ")})`);
    }
    this.provider = provider;
    const wanted = process.env.NRT_MODEL || DEFAULT_MODEL[provider];
    const model = registryGetModel(provider as any, wanted as any) as Model<any>;
    if (!model) {
      throw new Error(
        `live mode: could not resolve model '${wanted}' from the pi-ai '${provider}' registry (set NRT_MODEL to a valid id)`,
      );
    }
    const keyEnv = PROVIDER_KEY_ENV[provider];
    if (!process.env[keyEnv]) {
      throw new Error(
        `live mode (${provider}) requires ${keyEnv}. Set it (env or .env) and re-run. Unit mode needs no key.`,
      );
    }
    return model;
  }
}
