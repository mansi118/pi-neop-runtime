/**
 * Memory broker.
 *  - unit mode: fixture STM + no-op write sink (§2.1), so a Pi-agent runs with zero external deps.
 *  - live mode: proxies CORTEX-PALACE through the `/mcp` PalaceClient (GAP-1, ADR-neop-runtime) —
 *    `retrieve` → palace_search, `write` → palace_remember, scope baked from env, fail-closed.
 *
 * EMPTY=FAILURE is the PROOF's job, not the broker's: a contract/transport failure THROWS (loud),
 * but an ok-but-empty search returns [] — the GAP-1 ranked-retrieval proof asserts a non-empty ranked
 * hit (matching the jcode path's 0.986), so a dead/empty retrieval can't masquerade as success there.
 */

import { PalaceClient, palaceClientFromEnv } from "./palaceClient.ts";

export class MemoryBroker {
  mode: "unit" | "live";
  private stm: unknown[];
  private twin?: string;
  private client?: PalaceClient;
  writes: unknown[] = [];

  constructor(mode: "unit" | "live", stm: unknown[] = [], seedTwin?: string, client?: PalaceClient) {
    this.mode = mode;
    this.stm = [...stm];
    this.twin = seedTwin;
    // Live mode resolves the env-baked /mcp client at construction (fail-closed on blank/reserved
    // scope happens HERE, before any run starts). Tests may inject a client with a mock transport.
    if (mode === "live") this.client = client ?? palaceClientFromEnv();
  }

  async assembleContext(inputText: string) {
    return {
      input: inputText,
      twin: this.twin, // GAP-1 scope = memory; twin by-id fetch is out of scope here.
      stm: [...this.stm],
      retrieval: await this.retrieve(inputText),
    };
  }

  async retrieve(query: string, k = 5): Promise<unknown[]> {
    if (this.mode !== "live") return this.stm.slice(0, k);
    const r = await this.client!.call("palace_search", { query, limit: k });
    if (!r.ok) {
      throw new Error(
        `palace_search failed: http ${r.httpStatus} ${JSON.stringify(r.response).slice(0, 240)}`,
      );
    }
    // Mempalace /mcp envelope: { status:"ok", data: { results: [...] } }
    return (r.response?.data?.results ?? []) as unknown[];
  }

  async write(record: unknown): Promise<void> {
    if (this.mode !== "live") {
      this.writes.push(record);
      return;
    }
    // palace_remember params: { content, wingName?, category? } (shim tool schema).
    const rec = (record ?? {}) as Record<string, unknown>;
    const params: Record<string, unknown> = { content: rec.content ?? rec };
    if (rec.wingName != null) params.wingName = rec.wingName;
    if (rec.category != null) params.category = rec.category;
    const r = await this.client!.call("palace_remember", params);
    if (!r.ok) {
      throw new Error(
        `palace_remember failed: http ${r.httpStatus} ${JSON.stringify(r.response).slice(0, 240)}`,
      );
    }
    this.writes.push(record);
  }

  /**
   * Append a HUMAN-VERDICT run-event to the INTERIM fidelity store (Track 3) under the seat's OWN baked
   * scope (palace_put_run_event, kind="human_verdict"). This is the in-VPC persistence hop for a
   * Decision-Queue verdict the bridge forwards — scope is env-baked by the PalaceClient, never the
   * caller's. Unit mode records to `writes` (offline-gradeable); live mode calls the palace and throws
   * loudly on a non-ok response (a swallowed verdict would silently starve the fidelity clock).
   */
  async recordVerdict(event: Record<string, unknown>): Promise<void> {
    return this.putRunEvent("human_verdict", event);
  }

  /**
   * Append a SHADOW-PREDICTION run-event (kind="shadow_prediction") — the NEop's predicted reply for a
   * turn, which the fidelity runner grades against the eventual actual/verdict. Track 3 write-trigger.
   */
  async recordShadowPrediction(event: Record<string, unknown>): Promise<void> {
    return this.putRunEvent("shadow_prediction", event);
  }

  /**
   * Append a MEMORY-CANDIDATE run-event (kind="memory_candidate") — a durable-fact candidate the vault
   * runner reads via load_candidates and runs through the VL-1..5 gates. Track 3 write-trigger.
   */
  async recordCandidate(event: Record<string, unknown>): Promise<void> {
    return this.putRunEvent("memory_candidate", event);
  }

  /**
   * The shared run_events append (own env-baked scope, throw-loud on a non-ok palace write — a swallowed
   * run-event silently starves the fidelity/vault loops). Unit mode records to `writes` (offline-gradeable).
   */
  private async putRunEvent(kind: string, event: Record<string, unknown>): Promise<void> {
    if (this.mode !== "live") {
      this.writes.push({ kind, event });
      return;
    }
    const r = await this.client!.call("palace_put_run_event", { kind, event });
    if (!r.ok) {
      throw new Error(
        `palace_put_run_event failed: http ${r.httpStatus} ${JSON.stringify(r.response).slice(0, 240)}`,
      );
    }
    this.writes.push({ kind, event });
  }
}
