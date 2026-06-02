/**
 * Lightweight tracing (§4.4 latency / §4.5 `nrt trace`). One span per phase with
 * wall-clock duration + a token/cost ledger fed from real pi Agent usage.
 */

import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

export interface Span {
  name: string;
  durationMs: number;
  attrs: Record<string, unknown>;
}

export class Trace {
  runId: string;
  neop: string;
  caseId: string;
  spans: Span[] = [];
  toolCalls: { tool: string; argsHash: string; ok: boolean }[] = [];
  deniedTools: string[] = [];
  transitions: string[] = [];
  tokensIn = 0;
  tokensOut = 0;
  costUsd = 0;

  constructor(runId: string, neop: string, caseId: string) {
    this.runId = runId;
    this.neop = neop;
    this.caseId = caseId;
  }

  async span<T>(name: string, attrs: Record<string, unknown>, fn: () => Promise<T> | T): Promise<T> {
    const start = performance.now();
    try {
      return await fn();
    } finally {
      this.spans.push({ name, durationMs: +(performance.now() - start).toFixed(2), attrs });
    }
  }

  recordTransition(src: string, dst: string): void {
    this.transitions.push(`${src} -> ${dst}`);
  }

  recordUsage(input: number, output: number, cost: number): void {
    this.tokensIn += input;
    this.tokensOut += output;
    this.costUsd = +(this.costUsd + cost).toFixed(6);
  }

  phaseLatencyS(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const s of this.spans) out[s.name] = +((out[s.name] ?? 0) + s.durationMs / 1000).toFixed(4);
    return out;
  }

  totalLatencyS(): number {
    return +(this.spans.reduce((a, s) => a + s.durationMs, 0) / 1000).toFixed(4);
  }

  toJSON() {
    return {
      run_id: this.runId,
      neop: this.neop,
      case_id: this.caseId,
      spans: this.spans,
      phase_latency_s: this.phaseLatencyS(),
      total_latency_s: this.totalLatencyS(),
      tool_calls: this.toolCalls,
      denied_tools: this.deniedTools,
      transitions: this.transitions,
      tokens: { in: this.tokensIn, out: this.tokensOut },
      cost_usd: this.costUsd,
    };
  }
}

const RUNS_DIR = ".nrt/runs";

export function persist(trace: Trace): string {
  mkdirSync(RUNS_DIR, { recursive: true });
  const out = join(RUNS_DIR, `${trace.runId}.json`);
  writeFileSync(out, JSON.stringify(trace.toJSON(), null, 2));
  return out;
}

export function loadTrace(runId: string): any {
  const p = join(RUNS_DIR, `${runId}.json`);
  if (!existsSync(p)) throw new Error(`no trace for run_id '${runId}' (looked in ${p})`);
  return JSON.parse(readFileSync(p, "utf8"));
}
