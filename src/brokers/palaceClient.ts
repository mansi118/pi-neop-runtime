/**
 * PalaceClient — the `/mcp` tenant chokepoint, ported to TS from the proven Python shim
 * `neop_jcode_adapter/palace_mcp_shim.py` (the exact contract that hit live ranked-retrieval 0.986 at
 * the jcode T0 spike). This is GAP-1 of ADR-neop-runtime: wiring the canonical Hermes/Pi runtime to
 * CORTEX-PALACE so it inherits what only the jcode path had proven.
 *
 * INVARIANTS (do not weaken — mirror the Python shim 1:1):
 *  - Scope (palaceId, neopId) is BAKED from env, NEVER accepted from the model.
 *  - Fail-CLOSED on blank scope: a blank neopId defaults to `_admin` server-side, which BYPASSES all
 *    ACL (CLAUDE.md invariant) — so blank palaceUrl/palaceId/neopId REFUSES construction.
 *  - Fail-CLOSED on an EXPLICIT privileged identity (`_admin`/`_system`) — else it'd be baked + signed
 *    into every request as a signed ACL-bypass channel.
 *  - The model may not supply scope/envelope keys in tool args (reject loudly, don't silently drop).
 *
 * REAL `/mcp` CONTRACT (verified against Mempalace `convex/http.ts`):
 *   POST {palaceUrl}
 *   body    = { tool, palaceId, neopId, params }
 *   header  = X-Palace-Neop: <neopId>   (+ optional forward-looking Ed25519 signature, not yet
 *                                         server-verified — Gate D deferred)
 *   success = HTTP 200 + { status: "ok", data: <toolResult> }   (palace_search → data.results[])
 *
 * The class core (buildRequest/guards) is pure and unit-testable with no network (node-only imports).
 */

import { createPrivateKey, createPublicKey, sign as edSign, type KeyObject } from "node:crypto";
import { readFileSync } from "node:fs";

// ── allowlist + guards (mirror palace_mcp_shim) ────────────────────────────────
// palace_put_run_event: the seat's OWN-scope append to the INTERIM fidelity run_events store (Track 3,
// Mempalace #31). Own-seat write, server-gated (remember) — the same posture as palace_remember, so it
// belongs in the base allowlist. The event payload is data (no scope/envelope keys — FORBIDDEN_ARG_KEYS
// still rejects any palaceId/neopId/tool/params the caller tries to smuggle in).
export const ALLOWED_TOOLS_BASE = new Set<string>(["palace_search", "palace_remember", "palace_put_run_event"]);
export const GATED_TOOLS = new Set<string>(["palace_get_closet"]); // not registered until Mempalace T8
export const FORBIDDEN_ARG_KEYS = new Set<string>(["palaceId", "neopId", "tool", "params"]);
export const RESERVED_IDENTITIES = new Set<string>(["_admin", "_system"]);

export class ShimError extends Error {}
export class ScopeNotConfigured extends ShimError {}
export class ToolRejected extends ShimError {}
export class ScopeSpoofRejected extends ShimError {}

// ── Ed25519 signer (forward-looking; not verified server-side yet) ─────────────
// RFC 8410 PKCS#8 wrapper for a raw 32-byte Ed25519 seed.
const PKCS8_ED25519_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

export class Ed25519Signer {
  private sk: KeyObject;
  readonly publicKeyB64: string;

  constructor(seed: Buffer) {
    if (seed.length !== 32) throw new ShimError(`ed25519 seed must be 32 bytes, got ${seed.length}`);
    this.sk = createPrivateKey({
      key: Buffer.concat([PKCS8_ED25519_PREFIX, seed]),
      format: "der",
      type: "pkcs8",
    });
    const jwk = createPublicKey(this.sk).export({ format: "jwk" }) as { x: string };
    this.publicKeyB64 = Buffer.from(jwk.x, "base64url").toString("base64"); // raw 32-byte pubkey, b64
  }

  sign(message: Buffer): string {
    return edSign(null, message, this.sk).toString("base64");
  }
}

/** Resolve PALACE_SIGNING_KEY_REF → signer. Never accepts a plaintext key inline (env: | file:). */
export function loadSigner(ref?: string): Ed25519Signer | undefined {
  if (!ref || !ref.trim()) return undefined;
  const idx = ref.indexOf(":");
  const scheme = idx < 0 ? ref : ref.slice(0, idx);
  const loc = idx < 0 ? "" : ref.slice(idx + 1);
  if (scheme === "env") {
    const val = process.env[loc];
    if (!val) throw new ShimError(`PALACE_SIGNING_KEY_REF env:${loc} is unset`);
    return new Ed25519Signer(Buffer.from(val.trim(), "base64"));
  }
  if (scheme === "file") {
    return new Ed25519Signer(Buffer.from(readFileSync(loc, "utf8").trim(), "base64"));
  }
  throw new ShimError(`unsupported PALACE_SIGNING_KEY_REF scheme: '${scheme}' (use env: or file:)`);
}

/** Deterministic JSON for signing: recursively key-sorted, compact (mirrors Python json sort_keys). */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value as Record<string, unknown>).sort()) {
      out[k] = canonicalize((value as Record<string, unknown>)[k]);
    }
    return out;
  }
  return value;
}
export function canonicalJson(body: unknown): Buffer {
  return Buffer.from(JSON.stringify(canonicalize(body)), "utf8");
}

/**
 * The Gate-D identity claim the palace VERIFIES (Mempalace convex/access/edgeIdentity.ts): the env-baked
 * (palaceId, neopId) + tool, newline-joined. Byte-identical to the Python shim's `_identity_claim` so the
 * palace reconstructs the exact bytes in JS with zero Python↔JS JSON drift (all three are all-string,
 * non-model fields). This — NOT the JSON body signature — is what closes the `_admin` spoof foot-gun.
 */
export function identityClaim(palaceId: string, neopId: string, tool: string): Buffer {
  return Buffer.from(`${palaceId}\n${neopId}\n${tool}`, "utf8");
}

// ── transport (injectable for tests) ───────────────────────────────────────────
export type Transport = (
  url: string,
  body: unknown,
  headers: Record<string, string>,
) => Promise<{ status: number; json: any }>;

const fetchTransport: Transport = async (url, body, headers) => {
  const r = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
  let json: any = {};
  try {
    json = await r.json();
  } catch {
    /* leave {} — non-JSON error body */
  }
  return { status: r.status, json };
};

// ── the client ──────────────────────────────────────────────────────────────────
export interface PalaceRequest {
  body: { tool: string; palaceId: string; neopId: string; params: Record<string, unknown> };
  headers: Record<string, string>;
}

export interface PalaceCallResult {
  httpStatus: number;
  response: any;
  ok: boolean; // HTTP 200 AND body.status === "ok"
}

export interface PalaceClientOpts {
  palaceUrl: string;
  palaceId: string;
  neopId: string;
  signingKeyRef?: string;
  enableGetCloset?: boolean;
  transport?: Transport;
}

export class PalaceClient {
  readonly palaceUrl: string;
  readonly palaceId: string;
  readonly neopId: string;
  private allowed: Set<string>;
  private signer?: Ed25519Signer;
  private transport: Transport;

  constructor(o: PalaceClientOpts) {
    // Fail-closed: blank scope would default to _admin server-side and bypass all ACL.
    if (!o.palaceUrl?.trim()) throw new ScopeNotConfigured("PALACE_MCP_URL is blank");
    if (!o.palaceId?.trim()) throw new ScopeNotConfigured("PALACE_ID is blank");
    if (!o.neopId?.trim()) throw new ScopeNotConfigured("NEOP_ID is blank");
    // Defense-in-depth: refuse a seat/palace configured AS a privileged bypass identity.
    if (RESERVED_IDENTITIES.has(o.neopId.trim()))
      throw new ScopeNotConfigured(`NEOP_ID '${o.neopId.trim()}' is a reserved privileged identity`);
    if (RESERVED_IDENTITIES.has(o.palaceId.trim()))
      throw new ScopeNotConfigured(`PALACE_ID '${o.palaceId.trim()}' is a reserved privileged identity`);
    this.palaceUrl = o.palaceUrl.trim();
    this.palaceId = o.palaceId.trim();
    this.neopId = o.neopId.trim();
    this.allowed = new Set(ALLOWED_TOOLS_BASE);
    if (o.enableGetCloset) for (const t of GATED_TOOLS) this.allowed.add(t);
    this.signer = loadSigner(o.signingKeyRef);
    this.transport = o.transport ?? fetchTransport;
  }

  /** Pure security core (unit-tested without network). Scope comes from env, NEVER from args. */
  buildRequest(name: string, args?: Record<string, unknown>): PalaceRequest {
    if (!this.allowed.has(name)) throw new ToolRejected(name);
    const params = { ...(args ?? {}) };
    const spoofed = Object.keys(params).filter((k) => FORBIDDEN_ARG_KEYS.has(k));
    if (spoofed.length)
      throw new ScopeSpoofRejected(`model supplied forbidden keys: ${spoofed.sort().join(",")}`);
    const body = { tool: name, palaceId: this.palaceId, neopId: this.neopId, params };
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "X-Palace-Neop": this.neopId,
    };
    if (this.signer) {
      headers["X-NEop-Signature"] = this.signer.sign(canonicalJson(body)); // body integrity (forward-looking)
      headers["X-NEop-Pubkey"] = this.signer.publicKeyB64;
      // Gate D: the claim the palace verifies (edgeIdentity.decideIdentity) — signed over (palaceId,
      // neopId, tool) so it reconstructs byte-for-byte server-side. Load-bearing once enable_bridge_identity.
      headers["X-NEop-Identity"] = this.signer.sign(identityClaim(this.palaceId, this.neopId, name));
    }
    return { body, headers };
  }

  async call(name: string, args?: Record<string, unknown>): Promise<PalaceCallResult> {
    const { body, headers } = this.buildRequest(name, args);
    const { status, json } = await this.transport(this.palaceUrl, body, headers);
    const ok = status === 200 && json?.status === "ok";
    return { httpStatus: status, response: json, ok };
  }
}

export function palaceClientFromEnv(transport?: Transport): PalaceClient {
  return new PalaceClient({
    palaceUrl: process.env.PALACE_MCP_URL ?? "",
    palaceId: process.env.PALACE_ID ?? "",
    neopId: process.env.NEOP_ID ?? "",
    signingKeyRef: process.env.PALACE_SIGNING_KEY_REF,
    enableGetCloset: ["1", "true", "yes"].includes(process.env.PALACE_ENABLE_GET_CLOSET ?? ""),
    transport,
  });
}
