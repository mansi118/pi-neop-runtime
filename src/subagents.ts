/**
 * Pi-subagents: planner / executor / verifier (NE-TSD-RT-V1 §2).
 *
 * Each is a REAL pi `Agent` run. The planner and verifier are single-shot model
 * calls (no tools); the executor runs a bounded agent loop with the allowlisted
 * pi AgentTools and a `beforeToolCall` allowlist guard. In unit mode the model
 * broker programs the faux provider so the loop is deterministic; in
 * integration/live mode the real model drives the same loop.
 */

import { Agent } from "@earendil-works/pi-agent-core";
import type { ModelBroker } from "./brokers/model.ts";
import type { ToolBroker } from "./brokers/tool.ts";
import type { Trace } from "./trace.ts";
import { type Plan, type Task, planFromObj } from "./plan.ts";
import { validatePlanV1 } from "./schema.ts";
import type { NeopDefinition } from "./loader.ts";

export function lastAssistantText(agent: Agent): string {
  const msgs = agent.state.messages;
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m: any = msgs[i];
    if (m.role === "assistant") {
      return (m.content ?? [])
        .filter((b: any) => b.type === "text")
        .map((b: any) => b.text)
        .join("");
    }
  }
  return "";
}

function extractJson(text: string): any {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1) throw new Error(`model reply contained no JSON object: ${text.slice(0, 200)}`);
  return JSON.parse(text.slice(start, end + 1));
}

function tallyUsage(agent: Agent, trace: Trace): void {
  for (const m of agent.state.messages as any[]) {
    if (m.role === "assistant" && m.usage) {
      trace.recordUsage(m.usage.input ?? 0, m.usage.output ?? 0, m.usage.cost?.total ?? 0);
    }
  }
}

export function newAgent(system: string, model: any, getApiKey: any, tools: any[], guard?: ToolBroker): Agent {
  return new Agent({
    initialState: { model, systemPrompt: system, tools },
    getApiKey,
    beforeToolCall: guard
      ? async (ctx) => {
          const g = guard.guard(ctx.toolCall.name);
          return g.block ? { block: true, reason: g.reason } : undefined;
        }
      : undefined,
  });
}

// ---- planner ------------------------------------------------------------
export async function runPlanner(
  neop: NeopDefinition,
  caseId: string,
  attempt: number,
  context: unknown,
  model: ModelBroker,
  trace: Trace,
): Promise<Plan> {
  model.program(model.planResponses(neop, caseId, attempt));
  const agent = newAgent(neop.plannerPrompt, model.getModel(), model.getApiKey, []);
  await agent.prompt(JSON.stringify({ context, replan_attempt: attempt }));
  tallyUsage(agent, trace);
  const raw = extractJson(lastAssistantText(agent));
  const stamped = model.stampPlan(neop, caseId, raw);
  validatePlanV1(stamped);
  return planFromObj(stamped);
}

// ---- executor -----------------------------------------------------------
export interface ExecOutcome {
  result: unknown;
  executed: boolean;
  error?: string;
}

export function taskArgs(task: Task): Record<string, string> {
  return { task_id: task.task_id, objective: task.description, acceptance: task.acceptance };
}

export async function runExecutor(
  neop: NeopDefinition,
  task: Task,
  tools: ToolBroker,
  model: ModelBroker,
  trace: Trace,
): Promise<ExecOutcome> {
  if (task.scope !== "tool" || !task.tool) {
    return { result: {}, executed: true };
  }
  // Allowlist is default-deny: a tool not in allow[] never even gets an AgentTool.
  if (!tools.allow.has(task.tool)) {
    tools.recordDenied(task.tool);
    return { result: { error: `tool '${task.tool}' not in allow[]` }, executed: false, error: `tool '${task.tool}' denied` };
  }
  const args = taskArgs(task);
  model.program(model.executeResponses(task, args));
  const before = tools.trace.toolCalls.length;
  const agent = newAgent(neop.executorPrompt, model.getModel(), model.getApiKey, tools.buildAgentTools(), tools);
  await agent.prompt(task.description);
  tallyUsage(agent, trace);
  const executed = tools.trace.toolCalls.length > before;
  if (!executed) {
    return { result: tools.lastResult ?? {}, executed: false, error: "tool did not execute" };
  }
  return { result: tools.lastResult, executed: true };
}

// ---- verifier -----------------------------------------------------------
export async function runVerifier(
  neop: NeopDefinition,
  caseId: string,
  task: Task,
  result: unknown,
  attempt: number,
  model: ModelBroker,
  trace: Trace,
): Promise<{ verdict: "pass" | "fail"; reason: string }> {
  model.program(model.verifyResponses(neop, caseId, task, attempt));
  const agent = newAgent(neop.verifierPrompt, model.getModel(), model.getApiKey, []);
  await agent.prompt(JSON.stringify({ task, result }));
  tallyUsage(agent, trace);
  const obj = extractJson(lastAssistantText(agent));
  const verdict = String(obj.verdict ?? "fail").toLowerCase().startsWith("p") ? "pass" : "fail";
  return { verdict, reason: String(obj.reason ?? "") };
}
