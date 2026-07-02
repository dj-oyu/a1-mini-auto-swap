import type { JobRow } from "./types.ts";
import type { Notifier, PrinterPort, QueueStore } from "./ports.ts";
import { resolveColorConsistency } from "./color-policy.ts";

export interface DispatcherOptions {
  /** Max attempts before retry halts and only notifies (spec 18, INV-QUEUE-03). */
  retryLimit?: number;
  /** Notification sink (spec 13/15). Optional; no-op when absent. */
  notifier?: Notifier;
  /** Warn (advisory) as soon as a swap leaves the stocker at/below this many
   *  spare plates — so a human can refill before the queue actually stalls.
   *  Default 1 (warn at "1 spare left", then again at "last plate on the bed"). */
  lowStockThreshold?: number;
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
  private readonly lowStockThreshold: number;

  constructor(
    private readonly repo: QueueStore,
    private readonly printer: PrinterPort,
    opts: DispatcherOptions = {},
  ) {
    this.retryLimit = opts.retryLimit ?? 3;
    this.notifier = opts.notifier;
    this.lowStockThreshold = opts.lowStockThreshold ?? 1;
  }

  /** Consume one stocker plate on a swap and, when that leaves the stocker at or
   *  below the low-water mark, emit an advisory heads-up (spec 13: cry-wolf
   *  hygiene — a whisper before the queue-stopping stocker_refill). Fires once
   *  per level since `remaining` decreases monotonically between refills. */
  private swapPlate(): void {
    this.repo.decrementStocker();
    const s = this.repo.getStocker();
    if (s && s.remaining <= this.lowStockThreshold) {
      this.notifier?.notify({
        type: "stocker_low",
        severity: "advisory",
        message:
          s.remaining === 0
            ? "最後のビルドプレートをベッドに載せました。補充してください"
            : `ビルドプレート残り${s.remaining}枚です。補充してください`,
      });
    }
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

  /** Normal completion: success, swap (-1), color-consistency handling, then
   *  auto-advance to the next job. */
  async onFinished(jobId: number): Promise<void> {
    const job = this.repo.getJob(jobId);
    this.repo.updateStatus(jobId, "success");
    this.swapPlate();
    // spec 15 (INV-NOTIFY-01); a substituted color must surface here — never
    // discovered after the fact (spec 14, INV-RUNOUT-02).
    this.notifier?.notify({
      type: "job_finished",
      jobId,
      ...(job?.substituted_color != null
        ? {
            severity: "advisory" as const,
            message: `完了（フィラメントが自動切替されました: ${job.substituted_color}。確認推奨）`,
          }
        : {}),
    });
    if (job) this.applyColorConsistency(job);
    await this.dispatchNext();
  }

  /** spec 12: if this plate substituted a color, either propagate the substitute
   *  to the project's remaining plates or block the project for a human decision. */
  private applyColorConsistency(job: JobRow): void {
    if (job.substituted_color == null || job.project_id == null) return; // INV-PROJECT-03
    const project = this.repo.getProject(job.project_id);
    if (!project) return;

    const decision = resolveColorConsistency(
      { hasProject: true, policy: project.color_consistency_policy },
      true,
    );

    if (decision.kind === "block") {
      this.repo.createPendingAction({
        type: "color_decision",
        severity: "blocking_job",
        job_id: job.id,
        project_id: job.project_id,
        message: `${project.name}: 色が代替されました。続行/待機を選んでください`,
      });
      this.notifier?.notify({
        type: "pending_action",
        jobId: job.id,
        projectId: job.project_id,
        severity: "blocking_job",
        message: "color_decision",
      });
    } else if (decision.kind === "propagate") {
      for (const q of this.repo.listByStatus("queued")) {
        if (q.project_id === job.project_id && job.substituted_slot != null) {
          this.repo.setSubstitution(q.id, job.substituted_slot, job.substituted_color);
        }
      }
    }
  }

  /** Abnormal end: fail + safe eject + swap (-1) + human-gated retry_decision. */
  async onFailed(jobId: number, error: string): Promise<void> {
    this.repo.updateStatus(jobId, "failed", error);
    this.repo.incrementAttempts(jobId);
    await this.printer.ejectAndReset();
    this.swapPlate();
    this.repo.createPendingAction({
      type: "retry_decision",
      severity: "blocking_job",
      job_id: jobId,
      message: error,
    });
    this.notifier?.notify({ type: "job_failed", jobId, severity: "blocking_job", message: error });
    // no auto re-dispatch (INV-QUEUE-02): retry is a human action.
  }

  /** Human-initiated stop of the running plate (spec 8/19): eject/reset the
   *  mechanism, mark the job aborted, swap (-1, forced eject — INV-STOCKER-02),
   *  then auto-advance to the next queued job. Only valid while printing; a
   *  no-op (returns false) otherwise so a stale UI click can't corrupt state. */
  async abort(jobId: number): Promise<boolean> {
    const job = this.repo.getJob(jobId);
    if (!job || job.status !== "printing") return false;
    await this.printer.ejectAndReset();
    this.repo.updateStatus(jobId, "aborted");
    this.swapPlate();
    this.notifier?.notify({ type: "aborted", jobId });
    await this.dispatchNext();
    return true;
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
