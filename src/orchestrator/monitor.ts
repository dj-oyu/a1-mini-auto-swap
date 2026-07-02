import type { OrchestratorMqttClient, PrinterStatus } from "./mqtt-client.ts";
import type { Dispatcher } from "../core/dispatcher.ts";
import type { QueueStore } from "../core/ports.ts";
import { jobSubtaskPrefix } from "../core/artifact.ts";
import { moduleLogger } from "../obs/default-logger.ts";

/**
 * Monitoring loop (spec ⑦): bridges observed printer status → dispatcher
 * reactions. When the printer transitions to FINISH/FAILED, the currently
 * printing DB job is completed/failed via the Dispatcher (which handles swap,
 * pending actions, notification, and auto-advance).
 *
 * Robustness:
 *  - Edge detection on (gcode_state, subtask_name): repeated identical reports
 *    (e.g. a reconnect pushall re-sending the same FINISH) are ignored, so a
 *    completion is processed exactly once.
 *  - Serialized handling: onFinished auto-dispatches the next job (async I/O);
 *    events are chained so handlers never overlap.
 *  - Correlation by subtask name (job-{id}.gcode.3mf), falling back to the
 *    single printing job (single-machine invariant INV-DISPATCH-03).
 */
export class Monitor {
  private lastKey = "";
  private chain: Promise<void> = Promise.resolve();
  private started = false;
  private readonly log = moduleLogger("monitor");
  private readonly onStatus = (s: PrinterStatus) => this.enqueue(s);

  constructor(
    private readonly client: OrchestratorMqttClient,
    private readonly store: QueueStore,
    private readonly dispatcher: Dispatcher,
  ) {}

  start(): void {
    if (this.started) return;
    this.started = true;
    this.client.on("status", this.onStatus);
  }

  stop(): void {
    this.client.off("status", this.onStatus);
    this.started = false;
  }

  private enqueue(s: PrinterStatus): void {
    this.chain = this.chain.then(() => this.handle(s)).catch((e) => {
      this.log.error("handler error", { event: "monitor_error", err: e instanceof Error ? e.message : String(e) });
    });
  }

  private async handle(s: PrinterStatus): Promise<void> {
    const key = `${s.gcodeState}:${s.subtaskName}`;
    if (key === this.lastKey) return; // ignore repeats (pushall resends)
    this.lastKey = key;

    if (s.gcodeState === "FINISH") {
      const job = this.currentJob(s.subtaskName);
      if (job) await this.dispatcher.onFinished(job.id);
    } else if (s.gcodeState === "FAILED") {
      const job = this.currentJob(s.subtaskName);
      if (job) await this.dispatcher.onFailed(job.id, describeHms(s));
    }
  }

  /** Correlate a report's subtask_name to the DB job it belongs to, STRICTLY by
   *  the job-{id}. prefix. No "single printing job" fallback: a non-queue
   *  artifact (eject.gcode.3mf, dry-rehearsal.gcode.3mf) whose FINISH/FAILED
   *  arrives while a real job is 'printing' must NOT be misattributed to that
   *  job (審 2026-07-02 — the fallback let an eject's FINISH fire onFinished on
   *  an unrelated print: bad stocker accounting + false completion). If nothing
   *  matches, return null and the monitor does nothing. */
  private currentJob(subtask: string): { id: number } | null {
    const printing = this.store.listByStatus("printing");
    return printing.find((j) => subtask.includes(jobSubtaskPrefix(j.id))) ?? null;
  }
}

function describeHms(s: PrinterStatus): string {
  if (s.hms.length === 0) return "printer reported FAILED";
  return "HMS " + s.hms.map((h) => "0x" + h.code.toString(16)).join(",");
}
