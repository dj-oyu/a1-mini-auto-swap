// Completion-time (ETA) calculation — spec ch10. Pure and clock-injected so
// tests are deterministic (no wall-clock).

export interface EtaInputs {
  /** current time, epoch ms (injected) */
  now: number;
  /** measured swap-sequence duration, ms (SWAP_DURATION_MS) */
  swapDurationMs: number;
  /** the currently printing job, if any — uses live mc_remaining_time (minutes) */
  running?: { id: number; remainingMinutes: number };
  /** queued jobs in position order, with their static slice estimate (seconds) */
  queued: Array<{ id: number; estimatedSeconds: number }>;
}

export interface EtaResult {
  /** epoch ms when the whole set finishes */
  projectEta: number;
  /** epoch ms when each plate (running + queued) completes */
  plateEtas: Record<number, number>;
}

/**
 * Advance a cursor through the running job (live remaining) and each queued job
 * (static estimate), adding one SWAP_DURATION_MS per plate boundary. plateEtas
 * are monotonic non-decreasing by construction (INV-ETA-03).
 */
export function calcEta(inp: EtaInputs): EtaResult {
  let cursor = inp.now;
  const plateEtas: Record<number, number> = {};

  if (inp.running) {
    cursor += inp.running.remainingMinutes * 60_000; // MQTT live value (INV-ETA-01)
    plateEtas[inp.running.id] = cursor;
    cursor += inp.swapDurationMs; // swap after the running plate (INV-ETA-02)
  }

  for (const job of inp.queued) {
    cursor += job.estimatedSeconds * 1000;
    plateEtas[job.id] = cursor;
    cursor += inp.swapDurationMs;
  }

  return { projectEta: cursor, plateEtas };
}

/** Rough per-swap overhead (seconds) between plates for project-level ETA
 *  aggregation (spec 10). Real SWAP_DURATION_MS calibration is a spec 19 open
 *  item; until measured this stays a coarse constant. */
export const SWAP_SEC = 60;

/**
 * Aggregate remaining seconds for a project's still-to-finish plates (spec 10):
 * sum of static slice estimates + one swap per plate boundary. Pure/no-clock —
 * the client turns it into a completion time and (for the running plate) swaps
 * in the live mc_remaining_time.
 */
export function projectRemainingSec(activeJobs: Array<{ estimated_seconds: number | null }>): number {
  if (activeJobs.length === 0) return 0;
  const est = activeJobs.reduce((s, j) => s + (j.estimated_seconds ?? 0), 0);
  return est + (activeJobs.length - 1) * SWAP_SEC;
}
