import type { Clock } from "./ports.ts";

// SWAP_DURATION_MS calibration (dry-rehearsal-gcode-spec.md §6, method §2).
// The only reliable wall-clock signal from the printer is the RUNNING→FINISH
// state transition, so a swap sample is measured *differentially*: run the same
// dry rehearsal with and without the appended swap; the swap duration is the
// difference (the motion test + homing + transfer + FINISH-lag all cancel).
// Pure here; the actual timing comes from RunTimer (Clock port), the aggregate
// from calibrateSwapDuration. Persisting to system_settings is the caller's job.

export interface DurationSample {
  withSwapMs: number;
  withoutSwapMs: number;
}

/** Differential swap duration for one paired run (§2), floored at 0. */
export function swapSampleMs(sample: DurationSample): number {
  return Math.max(0, sample.withSwapMs - sample.withoutSwapMs);
}

export function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const n = s.length;
  return n % 2 ? s[(n - 1) / 2]! : (s[n / 2 - 1]! + s[n / 2]!) / 2;
}

/**
 * Robust aggregate of swap-duration samples (ms): drop non-positive samples,
 * remove outliers beyond `madK`·MAD of the median, then take the median.
 * Returns null when there is no usable sample — the caller then KEEPS the
 * existing SWAP_DURATION_MS rather than setting it to 0 (INV-DRY-06).
 */
export function calibrateSwapDuration(samplesMs: number[], opts: { madK?: number } = {}): number | null {
  const positive = samplesMs.filter((s) => s > 0);
  if (positive.length === 0) return null;

  const med = median(positive);
  const mad = median(positive.map((s) => Math.abs(s - med)));
  const madK = opts.madK ?? 3;
  const kept = mad > 0 ? positive.filter((s) => Math.abs(s - med) <= madK * mad) : positive;

  const result = median(kept.length ? kept : positive);
  return result > 0 ? Math.round(result) : null;
}

/**
 * Measures one job's RUNNING→FINISH wall-clock via the Clock port. Fed printer
 * status states (from the MQTT client / monitor). A run that ends FAILED yields
 * no duration.
 */
export class RunTimer {
  private startMs: number | null = null;
  private endMs: number | null = null;
  private failed = false;

  constructor(private readonly clock: Clock) {}

  onState(gcodeState: string): void {
    if (gcodeState === "RUNNING" && this.startMs === null) {
      this.startMs = this.clock.now();
    } else if (gcodeState === "FINISH" && this.startMs !== null && this.endMs === null) {
      this.endMs = this.clock.now();
    } else if (gcodeState === "FAILED" && this.startMs !== null) {
      this.failed = true;
    }
  }

  /** Duration in ms, or null if the run did not cleanly RUNNING→FINISH. */
  durationMs(): number | null {
    if (this.failed || this.startMs === null || this.endMs === null) return null;
    return this.endMs - this.startMs;
  }

  reset(): void {
    this.startMs = null;
    this.endMs = null;
    this.failed = false;
  }
}
