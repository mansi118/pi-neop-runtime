/**
 * Session supervisor — drives one Pi-agent through the state machine (§2.1/§2.2).
 *
 * Owns the per-run transitions, the plan->execute->verify DAG, and phase
 * timeouts. Each phase delegates to a real pi Agent run via ./subagents. Returns
 * a RunResult the assertion engine grades. One supervisor per Pi-agent run.
 */

import { randomUUID } from "node:crypto";
import { ModelBroker, type Mode } from "./brokers/model.ts";
import { ToolBroker } from "./brokers/tool.ts";
import { MemoryBroker } from "./brokers/memory.ts";
import { ACPBroker } from "./brokers/acp.ts";
import type { NeopDefinition } from "./loader.ts";
import { type Plan, type Task, executionOrder } from "./plan.ts";
import { type State, assertTransition } from "./state.ts";
import { Trace } from "./trace.ts";
import { runPlanner, runExecutor, runVerifier } from "./subagents.ts";

export interface TaskOutcome {
  task_id: string;
  tool: string | null;
  verdict: "pass" | "fail";
  reason: string;
  acceptance: string;
  attempt: number;
}

export interface RunResult {
  runId: string;
  neop: string;
  caseId: string;
  terminalState: State;
  plan: Plan | null;
  taskOutcomes: TaskOutcome[];
  replansPerformed: number;
  trace: Trace;
  error?: string;
  acceptanceAllPass: boolean;
}

export class SessionSupervisor {
  neop: NeopDefinition;
  case: any;
  caseId: string;
  runId: string;
  private model: ModelBroker;
  private tools: ToolBroker;
  private memory: MemoryBroker;
  private acp: ACPBroker;
  private trace: Trace;
  private timeouts: any;
  private maxReplans: number;
  private approvalPolicy: string;
  private state: State = "LOADING";

  constructor(neop: NeopDefinition, testCase: any, mode: Mode = "unit") {
    this.neop = neop;
    this.case = testCase;
    this.caseId = testCase.case_id;
    this.runId = `run_${randomUUID().replace(/-/g, "").slice(0, 12)}`;

    const toolMode = mode === "live" ? "live" : "mock";
    this.trace = new Trace(this.runId, neop.neopId, this.caseId);
    this.model = new ModelBroker(mode);
    this.tools = new ToolBroker(neop, toolMode, this.trace);
    this.memory = new MemoryBroker(mode === "live" ? "live" : "unit", testCase.stm ?? [], testCase.seed_twin);
    this.acp = new ACPBroker(mode);

    this.timeouts = neop.frontmatter.limits.phase_timeout_s;
    this.maxReplans = neop.maxReplans;
    this.approvalPolicy = testCase.approvals ?? "grant";
  }

  getTrace(): Trace {
    return this.trace;
  }

  private to(dst: State): void {
    assertTransition(this.state, dst);
    this.trace.recordTransition(this.state, dst);
    this.state = dst;
  }

  async run(): Promise<RunResult> {
    try {
      return await this.runInner();
    } finally {
      this.model.dispose();
    }
  }

  private async runInner(): Promise<RunResult> {
    // LOADING -> ASSEMBLING (loader already validated; REJECTED is produced by the API).
    this.to("ASSEMBLING");
    const context = await this.trace.span("assemble", {}, () =>
      this.memory.assembleContext(this.case.input?.text ?? ""),
    );

    this.to("PLANNING");
    let attempt = 0;
    let plan = await this.trace.span("plan", { attempt }, () =>
      runPlanner(this.neop, this.caseId, attempt, context, this.model, this.trace),
    );

    let replansPerformed = 0;
    let outcomes: TaskOutcome[] = [];

    for (;;) {
      this.to("EXECUTING");
      outcomes = [];
      let failed: TaskOutcome | null = null;

      for (const task of executionOrder(plan)) {
        if (this.state === "VERIFYING") this.to("EXECUTING"); // next task

        // Side-effecting tools pause for approval (§2.2).
        if (task.tool && this.tools.isSideEffecting(task.tool)) {
          this.to("AWAITING_APPROVAL");
          if (this.approvalPolicy === "deny") {
            this.to("FAILED");
            return this.result(plan, outcomes, replansPerformed, "FAILED");
          }
          this.to("EXECUTING");
        }

        const exec = await this.trace.span("execute", { task_id: task.task_id, tool: task.tool }, () =>
          runExecutor(this.neop, task, this.tools, this.model, this.trace),
        );

        this.to("VERIFYING");
        let verdict: "pass" | "fail";
        let reason: string;
        if (exec.error) {
          verdict = "fail";
          reason = exec.error;
        } else {
          const v = await this.trace.span("verify", { task_id: task.task_id }, () =>
            runVerifier(this.neop, this.caseId, task, exec.result, attempt, this.model, this.trace),
          );
          verdict = v.verdict;
          reason = v.reason;
        }

        const outcome: TaskOutcome = {
          task_id: task.task_id,
          tool: task.tool,
          verdict,
          reason,
          acceptance: task.acceptance,
          attempt,
        };
        outcomes.push(outcome);
        if (verdict === "fail") {
          failed = outcome;
          break;
        }
      }

      if (!failed) {
        this.to("DONE");
        return this.result(plan, outcomes, replansPerformed, "DONE");
      }

      // A task failed verification -> REPLANNING decides the fate.
      this.to("REPLANNING");
      if (replansPerformed < this.maxReplans) {
        replansPerformed += 1;
        attempt += 1;
        this.to("PLANNING");
        plan = await this.trace.span("plan", { attempt }, () =>
          runPlanner(this.neop, this.caseId, attempt, context, this.model, this.trace),
        );
        continue;
      }
      this.to("ESCALATED");
      return this.result(plan, outcomes, replansPerformed, "ESCALATED");
    }
  }

  private result(
    plan: Plan | null,
    outcomes: TaskOutcome[],
    replans: number,
    terminal: State,
    error?: string,
  ): RunResult {
    this.state = terminal;
    return {
      runId: this.runId,
      neop: this.neop.neopId,
      caseId: this.caseId,
      terminalState: terminal,
      plan,
      taskOutcomes: outcomes,
      replansPerformed: replans,
      trace: this.trace,
      error,
      acceptanceAllPass: outcomes.length > 0 && outcomes.every((o) => o.verdict === "pass"),
    };
  }
}
