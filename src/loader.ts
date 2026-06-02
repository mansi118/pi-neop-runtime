/**
 * Loader — walk a NEop folder, parse + validate, return a live definition.
 * "Bad frontmatter -> load fails loud, never half-loads" (§2.1).
 */

import { readFileSync, existsSync, statSync } from "node:fs";
import { join, resolve, basename } from "node:path";
import { parse as parseYaml } from "yaml";
import {
  FrontmatterError,
  crossCheckTools,
  validateFrontmatter,
  validateToolsJson,
} from "./schema.ts";

const REQUIRED_PROMPTS = ["neop.md", "planner.md", "executor.md", "verifier.md"];
const FRONTMATTER_RE = /^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/;

export interface NeopDefinition {
  name: string;
  path: string;
  frontmatter: any;
  rolePrompt: string;
  plannerPrompt: string;
  executorPrompt: string;
  verifierPrompt: string;
  tools: any;
  capabilities: any;
  metrics: any;
  // convenience
  neopId: string;
  allow: string[];
  sideEffecting: Set<string>;
  maxReplans: number;
  fixturesDir: string;
}

function readJson(path: string, label: string): any {
  if (!existsSync(path)) throw new FrontmatterError(label, "required sidecar file is missing");
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    throw new FrontmatterError(label, `is not valid JSON: ${(e as Error).message}`);
  }
}

export function load(neopPath: string): NeopDefinition {
  const path = resolve(neopPath);
  if (!existsSync(path) || !statSync(path).isDirectory()) {
    throw new FrontmatterError(path, "NEop path is not a directory");
  }
  for (const f of REQUIRED_PROMPTS) {
    if (!existsSync(join(path, f))) throw new FrontmatterError(f, "required prompt file is missing");
  }

  const raw = readFileSync(join(path, "neop.md"), "utf8");
  const m = FRONTMATTER_RE.exec(raw);
  if (!m) throw new FrontmatterError("neop.md", "missing '---' YAML frontmatter block at top of neop.md");
  let frontmatter: any;
  try {
    frontmatter = parseYaml(m[1]) ?? {};
  } catch (e) {
    throw new FrontmatterError("neop.md", `frontmatter is not valid YAML: ${(e as Error).message}`);
  }
  validateFrontmatter(frontmatter);

  const tools = readJson(join(path, "tools.json"), "tools.json");
  validateToolsJson(tools);
  const capabilities = readJson(join(path, "capabilities.json"), "capabilities.json");
  const metrics = readJson(join(path, "metrics.json"), "metrics.json");

  crossCheckTools(frontmatter.tools ?? [], tools.allow ?? []);

  return {
    name: basename(path),
    path,
    frontmatter,
    rolePrompt: m[2].trim(),
    plannerPrompt: readFileSync(join(path, "planner.md"), "utf8"),
    executorPrompt: readFileSync(join(path, "executor.md"), "utf8"),
    verifierPrompt: readFileSync(join(path, "verifier.md"), "utf8"),
    tools,
    capabilities,
    metrics,
    neopId: frontmatter.neop_id,
    allow: [...(tools.allow ?? [])],
    sideEffecting: new Set<string>(tools.side_effecting ?? []),
    maxReplans: Number(frontmatter.limits.max_replans),
    fixturesDir: join(path, "fixtures"),
  };
}
