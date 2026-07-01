import type { Sut, InvariantResult } from "../../src/verify/sut.ts";
import type { Setup } from "../../src/verify/types.ts";

/**
 * Minimal in-memory Sut for exercising the scenario runner without the (not yet
 * built) orchestrator. Models just enough queue/stocker/dispatch behavior to
 * run a normal-path scenario: single machine, position-order dispatch, one swap
 * (remaining -1) per completion, auto-dispatch of the next queued job on finish.
 */
export class FakeSut implements Sut {
  private jobs = new Map<string, { state: string; order: number }>();
  private printing: string | null = null;
  private stocker = { capacity: 10, remaining: 10 };
  private pending = new Set<string>();
  private orderSeq = 0;

  async setup(setup: Setup): Promise<void> {
    this.jobs.clear();
    this.printing = null;
    this.pending.clear();
    this.orderSeq = 0;
    if (setup.stocker) this.stocker = { ...setup.stocker };
    for (const j of setup.jobs) this.jobs.set(j.id, { state: "new", order: this.orderSeq++ });
  }
  async teardown(): Promise<void> {}

  async upload(job: string): Promise<void> {
    this.job(job).state = "processing";
  }
  async confirmFilaments(job: string): Promise<void> {
    this.job(job).state = "queued";
  }
  async dispatchAll(): Promise<void> {
    if (this.printing !== null || this.stocker.remaining <= 0) return;
    const next = [...this.jobs.entries()]
      .filter(([, j]) => j.state === "queued")
      .sort((a, b) => a[1].order - b[1].order)[0];
    if (!next) return;
    next[1].state = "printing";
    this.printing = next[0];
  }
  async control(): Promise<void> {}
  async resolvePending(type: string): Promise<void> {
    this.pending.delete(type);
  }
  async retry(job: string): Promise<void> {
    this.job(job).state = "queued";
  }
  async refillStocker(): Promise<void> {
    this.stocker.remaining = this.stocker.capacity;
  }
  async finishCurrent(): Promise<void> {
    if (this.printing === null) return;
    this.job(this.printing).state = "success";
    this.stocker.remaining -= 1; // swap
    this.printing = null;
    await this.dispatchAll(); // orchestrator auto-advances to the next queued job
  }

  async jobState(job: string): Promise<string> {
    return this.job(job).state;
  }
  async stockerRemaining(): Promise<number> {
    return this.stocker.remaining;
  }
  async pendingActionExists(type: string): Promise<boolean> {
    return this.pending.has(type);
  }
  async printingCount(): Promise<number> {
    return this.printing === null ? 0 : 1;
  }
  async checkInvariant(id: string): Promise<InvariantResult> {
    if (id === "INV-STOCKER-01") {
      return this.stocker.remaining >= 0
        ? { ok: true }
        : { ok: false, detail: `remaining=${this.stocker.remaining}` };
    }
    return { ok: true }; // unmodeled invariants pass in the fake
  }

  // test helper: seed a pending action
  addPending(type: string): void {
    this.pending.add(type);
  }

  private job(id: string): { state: string; order: number } {
    const j = this.jobs.get(id);
    if (!j) throw new Error(`unknown job '${id}'`);
    return j;
  }
}
