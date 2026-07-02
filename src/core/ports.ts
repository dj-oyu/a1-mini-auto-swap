import type {
  JobRow,
  JobStatus,
  PendingActionRow,
  PendingActionType,
  ProjectRow,
  Severity,
  StockerRow,
} from "./types.ts";
import type { AmsTray } from "./runout.ts";

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
  /** Resume a paused (runout) print on an alternate AMS slot (spec 14/16 —
   *  exact MQTT command unverified; adapters may best-effort or no-op). */
  resumeWithAlternateSlot(jobId: number, slot: number): Promise<void>;
}

/** Live AMS state provider (adapter: derived from MQTT status, or a fake). */
export interface AmsProvider {
  getTrays(): AmsTray[];
}

/** Notification event (spec 13/15). Kept structural so adapters (webhook,
 *  recording, IoT republish) can route on `type`/`severity`. */
export interface NotifyEvent {
  type:
    | "job_started"
    | "job_finished"
    | "job_failed"
    | "aborted"
    | "stocker_low"
    | "waiting_for_refill"
    | "pending_action"
    | "filament_switched"
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
  getProject(id: number): ProjectRow | null;
  listByStatus(status: JobStatus): JobRow[];
  updateStatus(id: number, status: JobStatus, lastError?: string | null): void;
  setSubstitution(id: number, slot: number, color: string): void;
  incrementAttempts(id: number): void;
  getStocker(): StockerRow | null;
  decrementStocker(): void;
  getUnresolvedPendingActions(): PendingActionRow[];
  hasUnresolvedPendingAction(projectId: number, type: PendingActionType): boolean;
  getSetting(key: string): string | null;
  createPendingAction(input: {
    type: PendingActionType;
    severity: Severity;
    job_id?: number | null;
    project_id?: number | null;
    message?: string | null;
  }): number;
}
