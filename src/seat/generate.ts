/**
 * Tool-less single-shot generation — the ONE adapter that turns the pi Agent into a text→text function.
 *
 * WHY tool-less matters (security, B-fwd-seam-design.md): the intent classifier and the conversational
 * reply are a JUDGMENT and an ANSWER — not ACTIONS. Handing them a `Generate` ((system,user)->text) means
 * they PHYSICALLY cannot invoke a tool: a classifier that could call tools is a classifier that could ACT
 * on the very injection it is meant to resist. So `tools=[]` lives HERE, in one reviewable place, and
 * callers never receive a tool handle. This mirrors the PROVEN single-shot pattern of runPlanner /
 * runVerifier (subagents.ts): `newAgent(prompt, model, getApiKey, [])` → `lastAssistantText`.
 */
import { newAgent, lastAssistantText } from "../subagents.ts";
import type { ModelBroker } from "../brokers/model.ts";

/** A tool-less single generation. The seam's classifier + reply path speak ONLY this — no tool access. */
export type Generate = (system: string, user: string) => Promise<string>;

/** Bind a Generate to the runtime's ModelBroker. `[]` = NO tools: this is a judgment/answer, not an action. */
export function modelGenerate(model: ModelBroker): Generate {
  return async (system, user) => {
    const agent = newAgent(system, model.getModel(), model.getApiKey, []); // [] — tool-less by construction
    await agent.prompt(user);
    return lastAssistantText(agent);
  };
}
