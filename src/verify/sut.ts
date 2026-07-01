import type { Setup } from "./types.ts";

export interface InvariantResult {
  ok: boolean;
  detail?: string;
}

/**
 * System-under-test adapter. The scenario runner is decoupled from any concrete
 * target through this interface: the Phase 3 orchestrator+stub implement a real
 * adapter, while tests use an in-memory fake. Actions perform DSL operations;
 * the query methods back the `assert`/`wait_until` steps.
 */
export interface Sut {
  setup(setup: Setup): Promise<void>;
  teardown(): Promise<void>;

  // actions
  upload(job: string): Promise<void>;
  confirmFilaments(job: string): Promise<void>;
  dispatchAll(): Promise<void>;
  control(method: string, path: string, body?: unknown): Promise<void>;
  resolvePending(type: string): Promise<void>;
  retry(job: string): Promise<void>;
  refillStocker(): Promise<void>;
  finishCurrent(): Promise<void>;

  // queries
  jobState(job: string): Promise<string>;
  stockerRemaining(): Promise<number>;
  pendingActionExists(type: string): Promise<boolean>;
  printingCount(): Promise<number>;
  checkInvariant(id: string): Promise<InvariantResult>;
}
