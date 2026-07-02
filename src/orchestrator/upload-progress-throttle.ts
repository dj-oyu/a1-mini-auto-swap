import type { Clock } from "../core/ports.ts";

// Upload-progress throttling (spec: FTPS progress indicator). A ~100MB print
// artifact flushes in 64KiB chunks (ftps-transfer.ts), so onProgress fires
// roughly 1600 times per upload — far more than an SSE/UI consumer needs.
// This is orchestrator-layer plumbing (not core): it only shapes how often we
// forward an already-computed progress sample, no domain rules involved.

export interface UploadProgressSample {
  bytesSent: number;
  totalBytes: number;
}

/**
 * Pure decision: should THIS sample be forwarded, given the time of the last
 * forwarded sample? Two cases are always sent regardless of elapsed time:
 *  - the very first sample (`lastSentAt === null` — nothing has gone out yet)
 *  - completion (`bytesSent >= totalBytes` — the "upload done" transition must
 *    never be swallowed by the interval, or the UI would hang mid-bar).
 * Everything else is sent only once `intervalMs` has elapsed since the last
 * forwarded sample (default 150ms).
 */
export function shouldEmitUploadProgress(
  now: number,
  lastSentAt: number | null,
  bytesSent: number,
  totalBytes: number,
  intervalMs = 150,
): boolean {
  if (lastSentAt === null) return true;
  if (bytesSent >= totalBytes) return true;
  return now - lastSentAt >= intervalMs;
}

/**
 * Wraps a progress sink with the throttle above, driven by an injected Clock
 * (deterministic in tests — no wall-clock waits per CLAUDE.md). Each call to
 * this factory starts fresh (no `lastSentAt` carried over), so one instance
 * per transfer is the right lifetime — matches one uploadBytes() call.
 */
export function throttleUploadProgress(
  send: (p: UploadProgressSample) => void,
  clock: Clock,
  intervalMs = 150,
): (p: UploadProgressSample) => void {
  let lastSentAt: number | null = null;
  return (p: UploadProgressSample) => {
    const now = clock.now();
    if (shouldEmitUploadProgress(now, lastSentAt, p.bytesSent, p.totalBytes, intervalMs)) {
      lastSentAt = now;
      send(p);
    }
  };
}
