/** Fixture loading — eval.jsonl cases and golden_plans (§3.1, §4.3). */

import { readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import type { NeopDefinition } from "../loader.ts";
import { type Plan, planFromObj } from "../plan.ts";

export function loadCases(neop: NeopDefinition): any[] {
  const p = join(neop.fixturesDir, "eval.jsonl");
  if (!existsSync(p)) return [];
  const cases: any[] = [];
  const lines = readFileSync(p, "utf8").split("\n");
  lines.forEach((line, i) => {
    const t = line.trim();
    if (!t || t.startsWith("#")) return;
    try {
      cases.push(JSON.parse(t));
    } catch (e) {
      throw new Error(`${p}:${i + 1}: invalid JSON in eval.jsonl: ${(e as Error).message}`);
    }
  });
  return cases;
}

export function loadGolden(neop: NeopDefinition, rel: string): Plan | null {
  const p = join(neop.fixturesDir, rel);
  if (!existsSync(p)) return null;
  return planFromObj(JSON.parse(readFileSync(p, "utf8")));
}

export function writeGolden(neop: NeopDefinition, rel: string, plan: Plan): string {
  const p = join(neop.fixturesDir, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(plan, null, 2));
  return p;
}
