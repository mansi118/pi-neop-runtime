/**
 * Seat HTTP wrapper — `POST /seat/turn` (B-fwd-seam-design.md, Component 1). The destination the Python
 * nc_channels bridge forwards a Matrix message to. Turns a forwarded message into an intent-routed NEop turn
 * and returns a unified ReplyEnvelope.
 *
 * SECURITY POSTURE (the code that makes the prose true — review THIS, not the design doc):
 *  - AUTH, fail-closed: the bridge presents `Authorization: Bearer <FORWARD_TOKEN>`; compared CONSTANT-TIME.
 *    Blank FORWARD_TOKEN → REFUSE TO START (an unauthenticated seat endpoint anything co-resident could hit
 *    is fail-open). Never an open localhost endpoint.
 *  - SCOPE FROM ENV, NEVER PAYLOAD: the palace scope (palaceId/neopId) is baked from THIS process's env by
 *    the memory broker (palaceClientFromEnv), never read from the forwarded body. Defense-in-depth: if the
 *    body carries any scope/envelope key, REJECT LOUDLY (mirrors the palace client's scope-spoof rejection).
 *  - T9 STOP-AND-ASK: serving a LIVE turn (reply OR task) runs a real NEop = T9. `makeLiveHandlers` REFUSES
 *    unless NEOP_T9_ACK=yes (the HTTP analog of the CLI's --i-understand-this-is-T9). Standing the transport
 *    up is not T9; assembling the LIVE handlers is.
 *  - Phase-1 CONTAINMENT: the task path runs with approvals:"deny" — side-effecting steps escalate rather
 *    than fire. The first crossing cannot side-effect (b-fwd-seam-design.md decision #1).
 *
 * `handleTurn` (the security core) is PURE over injected handlers — unit-tested with no network/model.
 */
import { timingSafeEqual } from "node:crypto";
import http from "node:http";
import { classifyAndRoute, type RouteDecision } from "./intent.ts";
import { modelGenerate } from "./generate.ts";
import { replySeat, type MemoryLike, type ReplyEnvelope, type SeatNeop } from "./reply.ts";
import type { ModelBroker } from "../brokers/model.ts";
import { dispatch } from "../api.ts";
import { buildRunCase } from "../serve.ts";
import type { RunResult } from "../supervisor.ts";

export interface TurnRequest {
  message: string;
  conversationId: string;
  userId: string;
  idempotencyKey: string;
}

export interface WrapperConfig {
  forwardToken: string;
  t9Ack: boolean;
}

/** The three routing branches — injectable so `handleTurn` tests need no live model/network. */
export interface SeatHandlers {
  classify: (req: TurnRequest) => Promise<RouteDecision>;
  reply: (req: TurnRequest) => Promise<ReplyEnvelope>;
  runTask: (req: TurnRequest) => Promise<ReplyEnvelope>;
}

// Keys the caller must NEVER supply — scope is server-baked from env. Present in body ⇒ reject loudly.
export const FORBIDDEN_SCOPE_KEYS = ["palaceId", "neopId", "tool", "params", "scope"];

// ── auth (constant-time) ────────────────────────────────────────────────────────
/** Constant-time string compare; no early return on length (compare-to-self, then false). */
export function constantTimeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) {
    timingSafeEqual(bb, bb); // keep timing ~constant, don't branch-leak on length
    return false;
  }
  return timingSafeEqual(ab, bb);
}

function bearer(authHeader?: string): string | undefined {
  if (!authHeader) return undefined;
  return authHeader.startsWith("Bearer ") ? authHeader.slice("Bearer ".length) : undefined;
}

export function authOk(authHeader: string | undefined, token: string): boolean {
  const presented = bearer(authHeader);
  if (!presented || !token) return false;
  return constantTimeEqual(presented, token);
}

// ── request parsing (+ scope-spoof rejection) ────────────────────────────────────
export type ParseResult =
  | { ok: true; req: TurnRequest }
  | { ok: false; errcode: string; error: string };

export function parseTurn(rawBody: string): ParseResult {
  let obj: any;
  try {
    obj = JSON.parse(rawBody || "{}");
  } catch {
    return { ok: false, errcode: "M_NOT_JSON", error: "body is not JSON" };
  }
  if (obj === null || typeof obj !== "object" || Array.isArray(obj)) {
    return { ok: false, errcode: "M_BAD_JSON", error: "body must be a JSON object" };
  }
  const spoof = FORBIDDEN_SCOPE_KEYS.filter((k) => k in obj);
  if (spoof.length) {
    return {
      ok: false,
      errcode: "M_SCOPE_SPOOF",
      error: `scope is server-baked from env and must not be supplied by the caller: ${spoof.sort().join(",")}`,
    };
  }
  if (typeof obj.message !== "string" || !obj.message.trim()) {
    return { ok: false, errcode: "M_MISSING_MESSAGE", error: "message (non-empty string) is required" };
  }
  if (typeof obj.conversationId !== "string" || !obj.conversationId) {
    return { ok: false, errcode: "M_MISSING_CONVERSATION", error: "conversationId is required" };
  }
  return {
    ok: true,
    req: {
      message: obj.message,
      conversationId: obj.conversationId,
      userId: typeof obj.userId === "string" ? obj.userId : "",
      idempotencyKey: typeof obj.idempotencyKey === "string" ? obj.idempotencyKey : "",
    },
  };
}

// ── per-turn telemetry (returned to the transport for a structured log; NEVER sent to the caller) ─────
export interface TurnTelemetry {
  route: "conversational" | "actionable" | "error" | "rejected";
  status: number;
  totalMs: number; // classify + reply/task wall time inside handleTurn
  classifyMs?: number;
  retrievalCount?: number; // raw hits from palace_search
  retrievalKept?: number; // survived the relevance gate → actually injected as context
  retrievalMs?: number;
  genMs?: number;
  topScore?: number;
  minScore?: number; // the active relevance threshold (omitted when the gate is off)
  errcode?: string;
  error?: string; // the CAUSE of a 500 — logged for operators, not returned to the caller
}

// ── the security core: auth → parse → route (PURE over injected handlers) ─────────
export async function handleTurn(
  authHeader: string | undefined,
  rawBody: string,
  handlers: SeatHandlers,
  config: WrapperConfig,
): Promise<{ status: number; body: unknown; telemetry: TurnTelemetry }> {
  if (!authOk(authHeader, config.forwardToken)) {
    return {
      status: 403,
      body: { errcode: "M_FORBIDDEN", error: "bad or missing forward token" },
      telemetry: { route: "rejected", status: 403, totalMs: 0, errcode: "M_FORBIDDEN" },
    };
  }
  const parsed = parseTurn(rawBody);
  if (!parsed.ok) {
    return {
      status: 400,
      body: { errcode: parsed.errcode, error: parsed.error },
      telemetry: { route: "rejected", status: 400, totalMs: 0, errcode: parsed.errcode },
    };
  }
  const t0 = Date.now();
  try {
    const decision = await handlers.classify(parsed.req);
    const classifyMs = Date.now() - t0;
    const env =
      decision.route === "actionable"
        ? await handlers.runTask(parsed.req)
        : await handlers.reply(parsed.req);
    const m = (env.meta ?? {}) as Record<string, unknown>;
    return {
      status: 200,
      body: env,
      telemetry: {
        route: decision.route,
        status: 200,
        totalMs: Date.now() - t0,
        classifyMs,
        retrievalCount: typeof m.retrievalCount === "number" ? m.retrievalCount : undefined,
        retrievalKept: typeof m.retrievalKept === "number" ? m.retrievalKept : undefined,
        retrievalMs: typeof m.retrievalMs === "number" ? m.retrievalMs : undefined,
        genMs: typeof m.genMs === "number" ? m.genMs : undefined,
        topScore: typeof m.topScore === "number" ? m.topScore : undefined,
        minScore: typeof m.minScore === "number" ? m.minScore : undefined,
      },
    };
  } catch (e) {
    // graceful — never leak a stack/internal error to the caller, but DO capture the cause for the log
    // (before this, a 500 was fully opaque — you couldn't tell a model timeout from a palace ACL deny).
    return {
      status: 500,
      body: { errcode: "M_UNKNOWN", error: "the seat failed to handle the turn" },
      telemetry: {
        route: "error",
        status: 500,
        totalMs: Date.now() - t0,
        errcode: "M_UNKNOWN",
        error: (e as Error)?.message ? String((e as Error).message) : String(e),
      },
    };
  }
}

/** One structured, greppable per-turn log line. Timings + retrieval quality; no message/memory CONTENT
 *  (tenant data stays out of logs) — only counts, scores, and the 500 cause. */
export function formatTurnLog(t: TurnTelemetry): string {
  const f = (k: string, v: unknown) => (v === undefined ? "" : ` ${k}=${v}`);
  return (
    `seat-turn status=${t.status} route=${t.route} total_ms=${t.totalMs}` +
    f("classify_ms", t.classifyMs) +
    f("retrieval_ms", t.retrievalMs) +
    f("gen_ms", t.genMs) +
    f("retrieved", t.retrievalCount) +
    f("kept", t.retrievalKept) +
    f("top_score", t.topScore) +
    f("min_score", t.minScore) +
    f("errcode", t.errcode) +
    (t.error ? ` error=${JSON.stringify(t.error)}` : "")
  );
}

// ── RunResult → reply rendering (task path) ───────────────────────────────────────
export function renderRunResult(r: RunResult): ReplyEnvelope {
  const meta = { runId: r.runId, terminalState: r.terminalState, acceptanceAllPass: r.acceptanceAllPass };
  if (r.terminalState === "DONE") {
    const n = r.taskOutcomes?.length ?? 0;
    return { kind: "task", text: `Done — completed ${n} step${n === 1 ? "" : "s"}.`, meta };
  }
  if (r.terminalState === "ESCALATED") {
    // Phase-1 approvals:"deny" → side-effecting steps escalate instead of firing. Surface, do not act.
    return {
      kind: "task",
      text: "That needs an action I can't take yet — it requires approval, which isn't wired in this phase.",
      meta,
    };
  }
  return { kind: "task", text: `I couldn't complete that${r.error ? `: ${r.error}` : "."}`, meta };
}

// ── config (fail-closed on blank token) ───────────────────────────────────────────
export function assertWrapperConfig(env: NodeJS.ProcessEnv = process.env): WrapperConfig {
  const forwardToken = (env.FORWARD_TOKEN ?? "").trim();
  if (!forwardToken) {
    throw new Error(
      "REFUSING to start: FORWARD_TOKEN is blank. The seat wrapper authenticates the bridge with a shared " +
        "secret; an unauthenticated seat endpoint anything co-resident could hit is fail-open. Set FORWARD_TOKEN.",
    );
  }
  return { forwardToken, t9Ack: (env.NEOP_T9_ACK ?? "").trim() === "yes" };
}

// ── the LIVE assembly (the T9 gate lives HERE) ───────────────────────────────────
export interface LiveHandlerOpts {
  neopPath: string;
  neop: SeatNeop;
  model: ModelBroker;
  memory: MemoryLike; // constructed from env (palaceClientFromEnv) — scope is env-baked, never from payload
  t9Ack: boolean;
  minScore?: number; // relevance gate for retrieved memory (SEAT_MEMORY_MIN_SCORE); <=0 or unset = off
  now?: () => number;
}

export function makeLiveHandlers(opts: LiveHandlerOpts): SeatHandlers {
  if (!opts.t9Ack) {
    throw new Error(
      "REFUSING to build live seat handlers: serving a live turn IS the first-real-NEop gate (T9). It needs " +
        "the box (GAP-2 jail), a live palace (GAP-1), a model key, and A2/B proven. Set NEOP_T9_ACK=yes to acknowledge.",
    );
  }
  const gen = modelGenerate(opts.model);
  const now = opts.now ?? (() => Date.now());
  return {
    classify: (req) => classifyAndRoute(req.message, gen),
    reply: (req) => replySeat(opts.neop, { message: req.message }, { gen, memory: opts.memory }, { minScore: opts.minScore }),
    // Phase-1 CONTAINMENT: approvals:"deny" — the task plans/verifies but side-effecting steps cannot fire.
    runTask: async (req) =>
      renderRunResult(
        await dispatch(opts.neopPath, buildRunCase({ task: req.message, approvals: "deny" }, now()), "live"),
      ),
  };
}

// ── the thin node:http transport shell ────────────────────────────────────────────
export function serveTurn(
  config: WrapperConfig,
  handlers: SeatHandlers,
  opts: { port: number; host?: string; log?: (s: string) => void },
): http.Server {
  const server = http.createServer((req, res) => {
    const send = (status: number, body: unknown) => {
      const data = Buffer.from(JSON.stringify(body), "utf8");
      res.writeHead(status, { "Content-Type": "application/json", "Content-Length": data.length });
      res.end(data);
    };
    if (req.method !== "POST" || (req.url ?? "").split("?")[0] !== "/seat/turn") {
      return send(404, { errcode: "M_UNRECOGNIZED", error: "POST /seat/turn only" });
    }
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c as Buffer));
    req.on("end", async () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      const out = await handleTurn(req.headers["authorization"], raw, handlers, config);
      opts.log?.(formatTurnLog(out.telemetry)); // per-turn structured telemetry → stderr → CloudWatch
      send(out.status, out.body);
    });
    req.on("error", () => send(400, { errcode: "M_BAD_REQUEST", error: "read error" }));
  });
  server.listen(opts.port, opts.host ?? "127.0.0.1", () =>
    opts.log?.(`seat wrapper listening on ${opts.host ?? "127.0.0.1"}:${opts.port} (POST /seat/turn)`),
  );
  return server;
}
