/**
 * Tool broker — builds real pi AgentTools from the tools.json allowlist and the
 * fixtures/mocks bus, enforces default-deny, and records every call/denial.
 *
 * §8 "Mock keying": keyed by (tool, args-hash) with a per-tool __default__
 * fallback. The pi Agent executes these tools through its own tool-execution
 * machinery — the allowlist is also enforced via the Agent `beforeToolCall` hook
 * as defense in depth.
 */

import { createHash } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import type { NeopDefinition } from "../loader.ts";
import type { Trace } from "../trace.ts";

export class ToolDenied extends Error {
  tool: string;
  constructor(tool: string, reason: string) {
    super(`tool '${tool}' denied: ${reason}`);
    this.tool = tool;
  }
}

export function argsHash(args: Record<string, unknown>): string {
  const sorted = Object.keys(args ?? {})
    .sort()
    .reduce((acc: any, k) => ((acc[k] = (args as any)[k]), acc), {});
  return createHash("sha256").update(JSON.stringify(sorted)).digest("hex").slice(0, 12);
}

// In unit mode the executor passes a deterministic arg shape; in integration/live
// the real model chooses its own args. Keep the schema permissive so any
// well-formed call validates and resolves against the mock's __default__ bucket.
const TOOL_PARAMS = Type.Object(
  {
    task_id: Type.Optional(Type.String()),
    objective: Type.Optional(Type.String()),
    acceptance: Type.Optional(Type.String()),
  },
  { additionalProperties: true },
);

export class ToolBroker {
  allow: Set<string>;
  sideEffecting: Set<string>;
  mode: "mock" | "live";
  trace: Trace;
  private mocks: Record<string, Record<string, unknown>>;
  lastResult: unknown = null;

  constructor(neop: NeopDefinition, mode: "mock" | "live", trace: Trace) {
    this.allow = new Set(neop.allow);
    this.sideEffecting = neop.sideEffecting;
    this.mode = mode;
    this.trace = trace;
    this.mocks = mode === "live" ? {} : this.loadMocks(neop);
  }

  private loadMocks(neop: NeopDefinition): Record<string, Record<string, unknown>> {
    const p = join(neop.fixturesDir, "mocks", "mocks.json");
    return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : {};
  }

  isSideEffecting(tool: string): boolean {
    return this.sideEffecting.has(tool);
  }

  private resolveMock(tool: string, args: Record<string, unknown>): unknown {
    const bucket = this.mocks[tool];
    if (!bucket) throw new ToolDenied(tool, `no mock fixture for tool '${tool}'`);
    const h = argsHash(args);
    if (h in bucket) return bucket[h];
    if ("__default__" in bucket) return bucket.__default__;
    throw new ToolDenied(tool, `no mock for args-hash ${h} and no __default__`);
  }

  /** Build the pi AgentTools for exactly the allowlisted tools. */
  buildAgentTools(): any[] {
    return [...this.allow].map((tool) => ({
      name: tool,
      label: tool,
      description: `NEOP-brokered tool '${tool}' (mock-backed in test mode).`,
      parameters: TOOL_PARAMS,
      execute: async (_id: string, params: any) => {
        const result =
          this.mode === "live"
            ? (() => {
                throw new ToolDenied(tool, "live MCP not wired in this dev build");
              })()
            : this.resolveMock(tool, params);
        this.lastResult = result;
        this.trace.toolCalls.push({ tool, argsHash: argsHash(params), ok: true });
        return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
      },
    }));
  }

  /** Defense-in-depth allowlist guard for the Agent `beforeToolCall` hook. */
  guard = (toolName: string): { block: boolean; reason?: string } => {
    if (!this.allow.has(toolName)) {
      this.trace.deniedTools.push(toolName);
      return { block: true, reason: `tool '${toolName}' not in tools.json allow[] (default-deny)` };
    }
    return { block: false };
  };

  recordDenied(tool: string): void {
    this.trace.deniedTools.push(tool);
  }
}
