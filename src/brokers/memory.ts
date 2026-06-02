/**
 * Memory broker — fixture STM + no-op write sink in test mode (§2.1), so a
 * Pi-agent runs with zero external dependencies. Live mode would proxy PALACE.
 */

export class MemoryBroker {
  mode: "unit" | "live";
  private stm: unknown[];
  private twin?: string;
  writes: unknown[] = [];

  constructor(mode: "unit" | "live", stm: unknown[] = [], seedTwin?: string) {
    this.mode = mode;
    this.stm = [...stm];
    this.twin = seedTwin;
  }

  assembleContext(inputText: string) {
    return { input: inputText, twin: this.twin, stm: [...this.stm], retrieval: this.retrieve(inputText) };
  }

  retrieve(_query: string, k = 5): unknown[] {
    if (this.mode === "live") throw new Error("live PALACE retrieval not wired in this dev build");
    return this.stm.slice(0, k);
  }

  write(record: unknown): void {
    this.writes.push(record);
  }
}
