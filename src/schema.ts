/**
 * Frontmatter + sidecar validation (NE-TSD-RT-V1 §3.2).
 *
 * Emits *named* errors — the doc requires loading to "fail loud with a named
 * frontmatter error", never half-load.
 */

export const ROLE_FAMILIES = new Set(["sales", "recon", "ops", "support", "research"]);

export class FrontmatterError extends Error {
  field: string;
  constructor(field: string, message: string) {
    super(`${field}: ${message}`);
    this.field = field;
    this.name = "FrontmatterError";
  }
}

function req(d: any, key: string, path: string, type: "string" | "number" | "object" | "array") {
  if (d == null || !(key in d)) throw new FrontmatterError(`${path}${key}`, "is required but missing");
  const v = d[key];
  const ok =
    type === "array" ? Array.isArray(v) : type === "object" ? v && typeof v === "object" && !Array.isArray(v) : typeof v === type;
  if (!ok) throw new FrontmatterError(`${path}${key}`, `must be ${type}, got ${Array.isArray(v) ? "array" : typeof v}`);
  return v;
}

export function validateFrontmatter(fm: any): void {
  if (!fm || typeof fm !== "object" || Array.isArray(fm)) {
    throw new FrontmatterError("<root>", "frontmatter must be a YAML mapping");
  }
  req(fm, "neop_id", "", "string");
  req(fm, "version", "", "number");
  const rf = req(fm, "role_family", "", "string");
  if (!ROLE_FAMILIES.has(rf)) {
    throw new FrontmatterError("role_family", `must be one of [${[...ROLE_FAMILIES].sort()}], got '${rf}'`);
  }
  const model = req(fm, "model", "", "object");
  for (const k of ["planner", "executor", "classifier"]) req(model, k, "model.", "string");

  const limits = req(fm, "limits", "", "object");
  const mr = req(limits, "max_replans", "limits.", "number");
  if (mr < 0) throw new FrontmatterError("limits.max_replans", "must be >= 0");
  const pt = req(limits, "phase_timeout_s", "limits.", "object");
  for (const k of ["plan", "execute", "verify"]) {
    const v = req(pt, k, "limits.phase_timeout_s.", "number");
    if (v <= 0) throw new FrontmatterError(`limits.phase_timeout_s.${k}`, "must be > 0");
  }

  const tools = req(fm, "tools", "", "array");
  tools.forEach((t: any, i: number) => {
    if (typeof t !== "string") throw new FrontmatterError(`tools[${i}]`, "must be a string tool name");
  });

  if (fm.acp != null) {
    if (typeof fm.acp !== "object") throw new FrontmatterError("acp", "must be a mapping if present");
    if (fm.acp.publishes != null && !Array.isArray(fm.acp.publishes)) {
      throw new FrontmatterError("acp.publishes", "must be a list");
    }
  }
}

export function validateToolsJson(t: any): void {
  if (!t || typeof t !== "object") throw new FrontmatterError("tools.json", "must be a JSON object");
  if (!Array.isArray(t.allow) || !t.allow.every((x: any) => typeof x === "string")) {
    throw new FrontmatterError("tools.json.allow", "must be a list of tool-name strings");
  }
  const se = t.side_effecting ?? [];
  if (!Array.isArray(se) || !se.every((x: any) => typeof x === "string")) {
    throw new FrontmatterError("tools.json.side_effecting", "must be a list of tool-name strings");
  }
  for (const x of se) {
    if (!t.allow.includes(x)) {
      throw new FrontmatterError("tools.json.side_effecting", `'${x}' is side-effecting but not in allow[]`);
    }
  }
}

export function crossCheckTools(frontmatterTools: string[], allow: string[]): void {
  const extra = frontmatterTools.filter((x) => !allow.includes(x)).sort();
  if (extra.length) {
    throw new FrontmatterError("tools", `frontmatter tools [${extra}] are not in tools.json allow[]`);
  }
}

export function validatePlanV1(d: any): void {
  if (!d || typeof d !== "object") throw new FrontmatterError("plan", "must be a JSON object");
  if (d.plan_version !== "v1") throw new FrontmatterError("plan.plan_version", `must be 'v1', got '${d.plan_version}'`);
  if (!Array.isArray(d.tasks) || d.tasks.length === 0) {
    throw new FrontmatterError("plan.tasks", "must be a non-empty list");
  }
  const ids = new Set<string>();
  d.tasks.forEach((t: any, i: number) => {
    const p = `plan.tasks[${i}]`;
    if (!t || typeof t !== "object") throw new FrontmatterError(p, "must be an object");
    if (typeof t.task_id !== "string" || !t.task_id) throw new FrontmatterError(`${p}.task_id`, "must be a non-empty string");
    if (ids.has(t.task_id)) throw new FrontmatterError(`${p}.task_id`, `duplicate task_id '${t.task_id}'`);
    ids.add(t.task_id);
    if (t.depends_on != null && !Array.isArray(t.depends_on)) throw new FrontmatterError(`${p}.depends_on`, "must be a list");
  });
  for (const t of d.tasks) {
    for (const dep of t.depends_on ?? []) {
      if (!ids.has(dep)) throw new FrontmatterError(`plan.tasks[${t.task_id}].depends_on`, `unknown task '${dep}'`);
    }
  }
}
