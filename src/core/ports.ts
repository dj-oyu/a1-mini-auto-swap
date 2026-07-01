import type {
  JobRow,
  JobStatus,
  PendingActionRow,
  PendingActionType,
  Severity,
  StockerRow,
} from "./types.ts";

/**
 * Core ports (hexagonal boundaries). The domain services (dispatcher, …) depend
 * only on these interfaces; concrete adapters live in db/ (persistence),
 * orchestrator/ (MQTT/FTPS), stub/ (the printer double), and notifier adapters.
 */

/** Printer-facing side of dispatch (adapter: orchestrator MqttFtpsPrinter, or a
 *  direct-to-stub driver in tests). */
export interface PrinterPort {
  /** Upload + start printing a job (FTPS → MQTT project_file). */
  startPrint(job: JobRow): Promise<void>;
  /** Return the mechanism to a safe state after a failure/abort (homing + swap). */
  ejectAndReset(): Promise<void>;
}

/** Notification event (spec 13/15). Kept structural so adapters (webhook,
 *  recording, IoT republish) can route on `type`/`severity`. */
export interface NotifyEvent {
  type:
    | "job_started"
    | "job_finished"
    | "job_failed"
    | "waiting_for_refill"
    | "pending_action"
    | "timeout";
  jobId?: number;
  projectId?: number;
  severity?: Severity;
  message?: string;
}

/** Notification sink (adapter: Discord/Slack webhook, or a recorder in tests). */
export interface Notifier {
  notify(event: NotifyEvent): void;
}

/** Clock port so time-dependent logic (ETA, escalation) stays deterministic. */
export interface Clock {
  now(): number; // epoch ms
}

export const systemClock: Clock = { now: () => Date.now() };

/**
 * The persistence surface the dispatcher needs — a narrow subset of the full
 * Repo, so core depends on an interface rather than the concrete SQLite class.
 * The db Repo satisfies this structurally.
 */
export interface QueueStore {
  getJob(id: number): JobRow | null;
  listByStatus(status: JobStatus): JobRow[];
  updateStatus(id: number, status: JobStatus, lastError?: string | null): void;
  incrementAttempts(id: number): void;
  getStocker(): StockerRow | null;
  decrementStocker(): void;
  getUnresolvedPendingActions(): PendingActionRow[];
  hasUnresolvedPendingAction(projectId: number, type: PendingActionType): boolean;
  createPendingAction(input: {
    type: PendingActionType;
    severity: Severity;
    job_id?: number | null;
    project_id?: number | null;
    message?: string | null;
  }): number;
}
