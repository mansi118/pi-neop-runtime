/**
 * plan.v1 — the DAG a planner Pi-subagent emits (NE-TSD-RT-V1 §3.3) plus the
 * structural diff used for golden-plan regression (§8 "Plan structural-diff
 * rule"): compare task set + dependency edges + tool assignment; ignore prose
 * and the ordering of independent tasks.
 */

import { createHash } from "node:crypto";

export interface Task {
  task_id: string;
  description: string;
  depends_on: string[];
  tool: string | null;
  acceptance: string;
  scope: string;
}

export interface Plan {
  plan_version: string;
  plan_id: string;
  neop: string;
  tasks: Task[];
  max_replans: number;
}

export function taskFromObj(d: any): Task {
  return {
    task_id: d.task_id,
    description: d.description ?? "",
    depends_on: Array.isArray(d.depends_on) ? [...d.depends_on] : [],
    tool: d.tool ?? null,
    acceptance: d.acceptance ?? "",
    scope: d.scope ?? "tool",
  };
}

export function planFromObj(d: any): Plan {
  return {
    plan_version: d.plan_version ?? "v1",
    plan_id: d.plan_id ?? "",
    neop: d.neop ?? "",
    tasks: (d.tasks ?? []).map(taskFromObj),
    max_replans: Number(d.max_replans ?? 2),
  };
}

export function deterministicPlanId(neop: string, caseId: string): string {
  const h = createHash("sha256").update(`${neop}:${caseId}`).digest("hex").slice(0, 16);
  return `plan_${h}`;
}

/** Topological order over depends_on; independent tasks keep declared order. */
export function executionOrder(plan: Plan): Task[] {
  const byId = new Map(plan.tasks.map((t) => [t.task_id, t]));
  for (const t of plan.tasks) {
    for (const dep of t.depends_on) {
      if (!byId.has(dep)) throw new Error(`task ${t.task_id} depends on unknown task ${dep}`);
    }
  }
  const done = new Set<string>();
  const order: Task[] = [];
  let remaining = [...plan.tasks];
  while (remaining.length) {
    const ready = remaining.filter((t) => t.depends_on.every((d) => done.has(d)));
    if (ready.length === 0) {
      throw new Error(`plan has a dependency cycle among ${remaining.map((t) => t.task_id)}`);
    }
    for (const t of ready) {
      order.push(t);
      done.add(t.task_id);
    }
    remaining = remaining.filter((t) => !done.has(t.task_id));
  }
  return order;
}

function structuralSignature(plan: Plan) {
  return plan.tasks
    .map((t) => ({
      task_id: t.task_id,
      tool: t.tool,
      depends_on: [...t.depends_on].sort(),
      scope: t.scope,
    }))
    .sort((a, b) => a.task_id.localeCompare(b.task_id));
}

/** Returns human-readable diffs. Empty array == structural match. */
export function structuralDiff(emitted: Plan, golden: Plan): string[] {
  const diffs: string[] = [];
  if (emitted.neop !== golden.neop) {
    diffs.push(`neop: emitted=${emitted.neop} golden=${golden.neop}`);
  }
  const e = new Map(structuralSignature(emitted).map((t) => [t.task_id, t]));
  const g = new Map(structuralSignature(golden).map((t) => [t.task_id, t]));
  for (const id of [...e.keys()].filter((k) => !g.has(k)).sort()) {
    diffs.push(`unexpected task ${id} (tool=${e.get(id)!.tool})`);
  }
  for (const id of [...g.keys()].filter((k) => !e.has(k)).sort()) {
    diffs.push(`missing task ${id} (golden tool=${g.get(id)!.tool})`);
  }
  for (const id of [...e.keys()].filter((k) => g.has(k)).sort()) {
    const et = e.get(id)!;
    const gt = g.get(id)!;
    if (et.tool !== gt.tool) diffs.push(`task ${id}: tool emitted=${et.tool} golden=${gt.tool}`);
    if (JSON.stringify(et.depends_on) !== JSON.stringify(gt.depends_on)) {
      diffs.push(`task ${id}: depends_on emitted=[${et.depends_on}] golden=[${gt.depends_on}]`);
    }
    if (et.scope !== gt.scope) diffs.push(`task ${id}: scope emitted=${et.scope} golden=${gt.scope}`);
  }
  return diffs;
}

/** Byte-stable serialization for the determinism check (criterion 3). */
export function canonicalBytes(plan: Plan): string {
  const sortKeys = (obj: any): any => {
    if (Array.isArray(obj)) return obj.map(sortKeys);
    if (obj && typeof obj === "object") {
      return Object.keys(obj)
        .sort()
        .reduce((acc: any, k) => ((acc[k] = sortKeys(obj[k])), acc), {});
    }
    return obj;
  };
  return JSON.stringify(sortKeys(plan));
}
