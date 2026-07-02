import type { Repo } from "../db/repo.ts";
import type { JobRow } from "../db/types.ts";
import type { Notifier, PrinterPort } from "../core/ports.ts";
import { Dispatcher } from "../core/dispatcher.ts";
import { CompositeNotifier } from "../core/composite-notifier.ts";
import { Monitor } from "./monitor.ts";
import { OrchestratorMqttClient, type PrinterStatus } from "./mqtt-client.ts";
import {
  PrintfarmGateway,
  type ProgressView,
  type QueueJobView,
  type QueueSnapshot,
} from "./gateway.ts";

// Composition root wiring (spec 3). Assembles the core loop from adapters:
//   printer status ──▶ Monitor ──▶ Dispatcher ──▶ Notifier (webhook + gateway)
// and republishes the retained printfarm/* snapshots to the gateway on every
// observed status change. Kept as a factory so the whole vertical is
// integration-testable against the in-process stub.

export interface OrchestratorDeps {
  repo: Repo;
  printer: PrinterPort;
  notifier: Notifier;
  /** printfarm/* republish gateway (spec 16). Optional: when the deployment has
   *  no Mosquitto broker configured (e.g. dev/test), the gateway is omitted and
   *  the printfarm/* republish + progress publish are simply skipped. */
  gateway?: PrintfarmGateway;
  status: OrchestratorMqttClient;
  retryLimit?: number;
  lowStockThreshold?: number;
}

export interface Orchestrator {
  dispatcher: Dispatcher;
  monitor: Monitor;
  /** Publish the current queue snapshot to the gateway (retained). */
  republishQueue(): void;
}

export function createOrchestrator(deps: OrchestratorDeps): Orchestrator {
  const republishQueue = () => deps.gateway?.publishQueue(toQueueSnapshot(deps.repo));

  // Republish the retained queue snapshot on every dispatcher NOTIFY. The
  // dispatcher notifies AFTER it has changed state (success/fail/pending), so
  // the snapshot reflects the new state — unlike a raw status listener, which
  // would fire before the Monitor's async onFinished updates the DB.
  const notifier = new CompositeNotifier([deps.notifier, { notify: () => republishQueue() }]);

  const dispatcher = new Dispatcher(deps.repo, deps.printer, {
    notifier,
    retryLimit: deps.retryLimit,
    lowStockThreshold: deps.lowStockThreshold,
  });
  const monitor = new Monitor(deps.status, deps.repo, dispatcher);
  monitor.start();

  // Live progress reflects the printer's status directly (safe to publish on
  // the raw status event). No-op when there's no gateway configured.
  if (deps.gateway) {
    const gateway = deps.gateway;
    deps.status.on("status", (s: PrinterStatus) => {
      const progress = toProgressView(s, deps.repo);
      if (progress) gateway.publishProgress(progress);
    });
  }

  republishQueue(); // initial snapshot
  return { dispatcher, monitor, republishQueue };
}

// ── view mappers ─────────────────────────────────────────────────────────────

export function toQueueJobView(job: JobRow, repo: Repo): QueueJobView {
  const project = job.project_id != null ? (repo.getProject(job.project_id)?.name ?? null) : null;
  return {
    id: job.id,
    filename: job.filename,
    status: job.status,
    project,
    position: job.position,
    attempts: job.attempts,
    eta_epoch_ms: null, // ETA wiring (calcEta over swap_duration_ms) is a later slice
    substituted: job.substituted_color != null,
  };
}

export function toQueueSnapshot(repo: Repo): QueueSnapshot {
  const stocker = repo.getStocker();
  return {
    jobs: repo.listJobs().map((j) => toQueueJobView(j, repo)),
    stocker: stocker ?? { remaining: 0, capacity: 0 },
  };
}

export function toProgressView(status: PrinterStatus, repo: Repo): ProgressView | null {
  const printing = repo.listByStatus("printing")[0];
  if (!printing) return null;
  return {
    job_id: printing.id,
    subtask_name: status.subtaskName,
    gcode_state: status.gcodeState,
    percent: status.mcPercent,
    layer: 0,
    total_layer: 0,
    remaining_min: status.mcRemainingTime,
    eta_epoch_ms: null,
    project_eta_epoch_ms: null,
  };
}
