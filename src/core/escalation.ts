import type { PendingActionRow } from "./types.ts";
import type { Clock, Notifier } from "./ports.ts";

/** Narrow persistence surface for escalation (the db Repo satisfies this). */
export interface EscalationStore {
  getUnresolvedPendingActions(): PendingActionRow[];
  markPendingNotified(id: number, atIso: string): void;
}

export interface EscalationOptions {
  /** Re-notify interval for unresolved blocking_queue actions (spec 13: 30 min). */
  intervalMs?: number;
}

/**
 * spec 13 エスカレーション: unresolved pending_action with severity
 * 'blocking_queue' (the whole queue is stopped; a human must act) is
 * re-notified every interval until resolved (INV-PENDING-03). Resolved
 * actions never re-notify (INV-PENDING-05) — the store only surfaces
 * unresolved rows. blocking_job / advisory stay quiet between events
 * (spec 13: lower urgency, avoid cry-wolf).
 */
export class EscalationService {
  private readonly intervalMs: number;

  constructor(
    private readonly store: EscalationStore,
    private readonly notifier: Notifier,
    private readonly clock: Clock,
    opts: EscalationOptions = {},
  ) {
    this.intervalMs = opts.intervalMs ?? 30 * 60_000;
  }

  /** Scan and re-notify stale blocking_queue actions. Returns how many fired. */
  tick(): number {
    const now = this.clock.now();
    let fired = 0;
    for (const a of this.store.getUnresolvedPendingActions()) {
      if (a.severity !== "blocking_queue") continue;
      const last = a.notified_at == null ? Number.NEGATIVE_INFINITY : parseDbTime(a.notified_at);
      if (now - last < this.intervalMs) continue;
      this.notifier.notify({
        type: "pending_action",
        jobId: a.job_id ?? undefined,
        projectId: a.project_id ?? undefined,
        severity: a.severity,
        message: a.message ?? a.type,
      });
      this.store.markPendingNotified(a.id, new Date(now).toISOString());
      fired++;
    }
    return fired;
  }
}

/** SQLite datetime('now') emits "YYYY-MM-DD HH:MM:SS" in UTC with no zone
 *  marker — JS would parse that as *local* time. Normalize to ISO-UTC. */
function parseDbTime(s: string): number {
  return Date.parse(s.includes("T") ? s : s.replace(" ", "T") + "Z");
}
