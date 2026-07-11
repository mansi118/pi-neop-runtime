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
//
// amazon-bedrock (deploy-topology Decision 2): Bedrock/Nova over the sealed spine (no NAT). pi-ai supports it
// natively as the `amazon-bedrock` provider and reads BOTH the bearer token AND the region FROM ENV ITSELF
// (`AWS_BEARER_TOKEN_BEDROCK`, `AWS_REGION`/`AWS_DEFAULT_REGION`) at stream time — so for this provider the
// key/region flow WITHOUT `getApiKey` (that asymmetry is intentional; see `resolveBedrockModel`).
export const PROVIDER_KEY_ENV: Record<string, string> = {
  anthropic: "ANTHROPIC_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
  "amazon-bedrock": "AWS_BEARER_TOKEN_BEDROCK", // pi-ai reads this env directly (bypasses SigV4)
};
const DEFAULT_PROVIDER = "openrouter";
const DEFAULT_MODEL: Record<string, string> = {
  anthropic: "claude-sonnet-4-6",
  openrouter: "anthropic/claude-haiku-4.5", // ADR-llm classifier id; box-verify it's a live pi-ai openrouter id
  "amazon-bedrock": "apac.amazon.nova-lite-v1:0", // APAC inference profile; bare amazon.nova-* rejects on-demand
};

// pi-ai's registry only knows BARE bedrock ids, but on-demand Converse invoke needs the regional inference
// profile (`apac.*`) — bare ids reject (proven by Mempalace's bedrockLlm.ts + probe). pi-ai has NO region→
// profile derivation: it sends `model.id` verbatim as the Converse `modelId` (amazon-bedrock.js:98). So we
// fetch the bare catalog Model, then stamp the `apac.*` profile onto `model.id`. This map is bare↔profile.
const BEDROCK_PROFILE_TO_CATALOG: Record<string, string> = {
  "apac.amazon.nova-lite-v1:0": "amazon.nova-lite-v1:0",
  "apac.amazon.nova-micro-v1:0": "amazon.nova-micro-v1:0",
  "apac.amazon.nova-pro-v1:0": "amazon.nova-pro-v1:0",
  "apac.amazon.nova-2-lite-v1:0": "amazon.nova-2-lite-v1:0",
  // Anthropic Claude on Bedrock (unblocked 2026-07-10). Profile ↔ bare catalog id. Newer Claude ids may
  // not be in pi-ai's registry — resolveBedrockModel falls back to a known shell + stamps the profile.
  "global.anthropic.claude-sonnet-4-5-20250929-v1:0": "anthropic.claude-sonnet-4-5-20250929-v1:0",
  "global.anthropic.claude-haiku-4-5-20251001-v1:0": "anthropic.claude-haiku-4-5-20251001-v1:0",
  "apac.anthropic.claude-3-5-sonnet-20241022-v2:0": "anthropic.claude-3-5-sonnet-20241022-v2:0",
};
// The spine region. The bearer token is region-scoped — a us-east-1 token 403s against ap-south-1 (proven
// 2026-07-07) — so we pin this if the operator hasn't set AWS_REGION. Override via NRT_BEDROCK_REGION.
const DEFAULT_BEDROCK_REGION = "ap-south-1";

export function resolveProvider(env: NodeJS.ProcessEnv = process.env): string {
  return (env.NEOP_PROVIDER || env.CLASSIFIER_PROVIDER || DEFAULT_PROVIDER).toLowerCase();
}

export class ModelBroker {
  mode: Mode;
  private fauxReg?: ReturnType<typeof registerFauxProvider>;
  private model: Model<any>;
  private provider: string = DEFAULT_PROVIDER;
  private modelIdOverride?: string;

  // modelIdOverride lets two brokers on the SAME provider run different models (the Haiku fast tier vs the
  // Sonnet quality tier) without fighting over the single process-wide NRT_MODEL env. It wins over NRT_MODEL.
  constructor(mode: Mode, modelIdOverride?: string) {
    this.mode = mode;
    this.modelIdOverride = modelIdOverride;
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
    // Provider-aware (D2): OpenRouter primary, Anthropic if NEOP_PROVIDER=anthropic, amazon-bedrock for the
    // sealed spine. The model id rides NRT_MODEL; the three Pi-subagents all run on it. (Live id validity +
    // reachability are box-verified.)
    const provider = resolveProvider();
    if (!(provider in PROVIDER_KEY_ENV)) {
      throw new Error(`live mode: unknown provider '${provider}' (use ${Object.keys(PROVIDER_KEY_ENV).join(" | ")})`);
    }
    this.provider = provider;
    // Fail-closed on the key BEFORE resolving the model — one clear, named error, not a mystery downstream.
    const keyEnv = PROVIDER_KEY_ENV[provider];
    if (!process.env[keyEnv]) {
      throw new Error(
        `live mode (${provider}) requires ${keyEnv}. Set it (env or .env) and re-run. Unit mode needs no key.`,
      );
    }
    const wanted = this.modelIdOverride || process.env.NRT_MODEL || DEFAULT_MODEL[provider];
    if (provider === "amazon-bedrock") return this.resolveBedrockModel(wanted);
    const model = registryGetModel(provider as any, wanted as any) as Model<any>;
    if (!model) {
      throw new Error(
        `live mode: could not resolve model '${wanted}' from the pi-ai '${provider}' registry (set NRT_MODEL to a valid id)`,
      );
    }
    return model;
  }

  /**
   * Bedrock (Nova) via pi-ai's amazon-bedrock provider — the code half of deploy-topology Decision 2 (sealed
   * spine, no NAT). Two pi-ai facts drive this (verified in dist 2026-07-07), and they are the whole reason
   * this isn't a plain `registryGetModel`:
   *   1. The registry knows only BARE nova ids, but on-demand invoke needs the regional `apac.*` inference
   *      profile (bare rejects). pi-ai has no region→profile derivation — it sends `model.id` verbatim as the
   *      Converse `modelId` — so we fetch the bare catalog Model, then stamp the `apac.*` profile onto `.id`.
   *   2. bearer + region are read from env by pi-ai ITSELF at stream time. So `getApiKey` is moot here; we
   *      instead PIN the region (the token is region-scoped — a us-east-1 token 403s in ap-south-1).
   * Errors are named + distinct (auth vs unknown-id vs region) — the lesson of the model-egress thread.
   */
  private resolveBedrockModel(wanted: string): Model<any> {
    // Region: pi-ai reads AWS_REGION/AWS_DEFAULT_REGION at stream time (there is no getModel region arg). Pin
    // the spine region unless the operator has already chosen one — a region/token mismatch is a silent 403.
    const region =
      process.env.NRT_BEDROCK_REGION ||
      process.env.AWS_REGION ||
      process.env.AWS_DEFAULT_REGION ||
      DEFAULT_BEDROCK_REGION;
    process.env.AWS_REGION = region;
    process.env.AWS_DEFAULT_REGION = region;

    // Fetch the Model shell by its BARE catalog id (keeps pricing/capability metadata). Newer Claude bedrock
    // ids may not be in pi-ai's registry yet — pi-ai sends model.id verbatim as the Converse modelId, so the
    // shell is only a carrier: fall back to the always-present nova-lite shell and stamp the wanted id onto it.
    const catalogId = BEDROCK_PROFILE_TO_CATALOG[wanted] ?? wanted;
    const shell =
      (registryGetModel("amazon-bedrock" as any, catalogId as any) as Model<any>) ??
      (registryGetModel("amazon-bedrock" as any, "amazon.nova-lite-v1:0" as any) as Model<any>);
    if (!shell) {
      const known = Object.keys(BEDROCK_PROFILE_TO_CATALOG).join(", ");
      throw new Error(
        `live mode (amazon-bedrock): could not resolve a bedrock model shell for '${catalogId}' ` +
          `(derived from NRT_MODEL='${wanted}'). Set NRT_MODEL to one of: ${known}.`,
      );
    }
    // CLONE before stamping: the registry returns a SHARED Model object. Two brokers (fast + quality) resolving
    // bedrock would otherwise stamp the same instance and clobber each other's id. Clone keeps them independent.
    const model = Object.assign(Object.create(Object.getPrototypeOf(shell)), shell) as Model<any>;
    // Stamp the regional inference-profile id so the Converse request targets apac.*/global.* (bare rejects).
    (model as any).id = wanted;
    return model;
  }
}
