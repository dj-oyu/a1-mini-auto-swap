import type { JobRow } from "./types.ts";
import type { Notifier, PrinterPort, QueueStore } from "./ports.ts";

export interface DispatcherOptions {
  /** Max attempts before retry halts and only notifies (spec 18, INV-QUEUE-03). */
  retryLimit?: number;
  /** Notification sink (spec 13/15). Optional; no-op when absent. */
  notifier?: Notifier;
}

export type DispatchOutcome =
  | { dispatched: number }
  | { dispatched: null; reason: "busy" | "blocked_queue" | "stocker_empty" | "no_eligible_job" };

/**
 * The core loop's decision logic (spec 6/11/12/18). Pure over the Repo + an
 * injected PrinterPort — no MQTT/FTPS here. Enforces:
 *  - single machine: at most one 'printing' job (INV-DISPATCH-03)
 *  - position-order dispatch (INV-DISPATCH-02)
 *  - stocker-empty => stocker_refill(blocking_queue), no dispatch (INV-STOCKER-04)
 *  - a project blocked on color_decision does not block other projects (INV-DISPATCH-01)
 *  - any blocking_queue pending freezes dispatch (INV-CONSISTENCY-02)
 *  - swap decrements the stocker on both success and forced-eject (INV-STOCKER-02)
 *  - no auto-retry loop; retry is human-triggered (INV-QUEUE-02)
 */
export class Dispatcher {
  private readonly retryLimit: number;
  private readonly notifier?: Notifier;

  constructor(
    private readonly repo: QueueStore,
    private readonly printer: PrinterPort,
    opts: DispatcherOptions = {},
  ) {
    this.retryLimit = opts.retryLimit ?? 3;
    this.notifier = opts.notifier;
  }

  /** processing -> queued (after filament confirmation). */
  async enqueue(jobId: number): Promise<void> {
    this.repo.updateStatus(jobId, "queued");
  }

  /** Dispatch the next eligible queued job, or explain why nothing was sent. */
  async dispatchNext(): Promise<DispatchOutcome> {
    if (this.repo.listByStatus("printing").length > 0) {
      return { dispatched: null, reason: "busy" };
    }
    const unresolved = this.repo.getUnresolvedPendingActions();
    if (unresolved.some((a) => a.severity === "blocking_queue")) {
      return { dispatched: null, reason: "blocked_queue" };
    }

    const stocker = this.repo.getStocker();
    if (!stocker || stocker.remaining <= 0) {
      this.ensureStockerRefillPending();
      return { dispatched: null, reason: "stocker_empty" };
    }

    for (const job of this.repo.listByStatus("queued")) {
      if (job.project_id != null && this.repo.hasUnresolvedPendingAction(job.project_id, "color_decision")) {
        continue; // this project is paused; keep scanning others
      }
      return this.dispatch(job);
    }
    return { dispatched: null, reason: "no_eligible_job" };
  }

  private async dispatch(job: JobRow): Promise<DispatchOutcome> {
    this.repo.updateStatus(job.id, "printing");
    await this.printer.startPrint(this.repo.getJob(job.id)!);
    return { dispatched: job.id };
  }

  /** Normal completion: success, swap (-1), then auto-advance to the next job. */
  async onFinished(jobId: number): Promise<void> {
    this.repo.updateStatus(jobId, "success");
    this.repo.decrementStocker();
    this.notifier?.notify({ type: "job_finished", jobId }); // spec 15 (INV-NOTIFY-01)
    await this.dispatchNext();
  }

  /** Abnormal end: fail + safe eject + swap (-1) + human-gated retry_decision. */
  async onFailed(jobId: number, error: string): Promise<void> {
    this.repo.updateStatus(jobId, "failed", error);
    this.repo.incrementAttempts(jobId);
    await this.printer.ejectAndReset();
    this.repo.decrementStocker();
    this.repo.createPendingAction({
      type: "retry_decision",
      severity: "blocking_job",
      job_id: jobId,
      message: error,
    });
    this.notifier?.notify({ type: "job_failed", jobId, severity: "blocking_job", message: error });
    // no auto re-dispatch (INV-QUEUE-02): retry is a human action.
  }

  /** Human-triggered retry (spec 18). Re-queues unless the attempt cap is hit. */
  async retry(jobId: number): Promise<boolean> {
    const job = this.repo.getJob(jobId);
    if (!job) return false;
    if (job.attempts > this.retryLimit) {
      this.repo.createPendingAction({
        type: "mechanical_check",
        severity: "advisory",
        job_id: jobId,
        message: `retry limit (${this.retryLimit}) exceeded`,
      });
      return false; // halt: notify only (INV-QUEUE-03)
    }
    this.repo.updateStatus(jobId, "queued");
    return true;
  }

  private ensureStockerRefillPending(): void {
    const exists = this.repo.getUnresolvedPendingActions().some((a) => a.type === "stocker_refill");
    if (!exists) {
      this.repo.createPendingAction({
        type: "stocker_refill",
        severity: "blocking_queue",
        message: "ストッカーが空です",
      });
      this.notifier?.notify({
        type: "waiting_for_refill",
        severity: "blocking_queue",
        message: "ストッカーが空です",
      });
    }
  }
}
