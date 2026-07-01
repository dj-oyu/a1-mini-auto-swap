import { openDb } from "../db/index.ts";
import { Repo } from "../db/repo.ts";
import type { Database } from "bun:sqlite";
import type { JobRow, JobStatus } from "../db/types.ts";
import { Dispatcher } from "../orchestrator/dispatcher.ts";
import type { PrinterPort } from "../orchestrator/printer-port.ts";
import { calcEta } from "../orchestrator/eta.ts";
import { VirtualPrinter } from "../stub/virtual-printer.ts";
import type { Tray } from "../stub/types.ts";
import type { InvariantResult, Sut } from "./sut.ts";
import type { JobSpec, Setup } from "./types.ts";

const SWAP_DURATION_MS = 90_000;

const ALLOWED_TRANSITIONS = new Set([
  "processing>queued",
  "queued>printing",
  "printing>success",
  "printing>failed",
  "printing>aborted",
  "printing>waiting_for_refill",
  "waiting_for_refill>queued",
  "failed>queued",
  "aborted>queued",
]);

/** Repo that logs status transitions and the order jobs entered 'printing'. */
class RecordingRepo extends Repo {
  readonly transitions: Array<{ id: number; from: string; to: string }> = [];
  readonly printingOrder: number[] = [];

  constructor(db: Database) {
    super(db);
  }

  override updateStatus(id: number, status: JobStatus, lastError: string | null = null): void {
    const prev = this.getJob(id)?.status;
    super.updateStatus(id, status, lastError);
    if (prev && prev !== status) this.transitions.push({ id, from: prev, to: status });
    if (status === "printing") this.printingOrder.push(id);
  }
}

/** PrinterPort that drives the VirtualPrinter directly (no MQTT/FTPS) so
 *  scenarios are deterministic. Records the ams_mapping of each start. */
class StubDirectPrinter implements PrinterPort {
  readonly sentMappings: number[][] = [];
  constructor(
    private readonly printer: VirtualPrinter,
    private readonly amsMappingFor: (jobId: number) => number[],
  ) {}

  async startPrint(job: JobRow): Promise<void> {
    const mapping = this.amsMappingFor(job.id);
    this.sentMappings.push(mapping);
    const err = this.printer.receiveProjectFile({
      command: "project_file",
      param: "Metadata/plate_1.gcode",
      url: `ftp:///cache/job-${job.id}.gcode.3mf`,
      use_ams: true,
      ams_mapping: mapping,
    });
    if (err) throw new Error(err);
  }
  async ejectAndReset(): Promise<void> {
    this.printer.stop();
  }
}

/**
 * Concrete Sut wiring DB + dispatcher + a VirtualPrinter for the scenario
 * runner. Drives the real orchestrator decision logic (Dispatcher over Repo)
 * against the stub state machine, and mechanizes checkInvariant with real
 * hooks. This is what turns scenarios/S1,S2 green (Phase 3 完了条件).
 */
export class StubSut implements Sut {
  private printer!: VirtualPrinter;
  private repo!: RecordingRepo;
  private printerPort!: StubDirectPrinter;
  private dispatcher!: Dispatcher;
  private closeDb: (() => void) | null = null;

  private readonly logicalToDbId = new Map<string, number>();
  private readonly specByDbId = new Map<number, JobSpec>();
  private amsConfig: Setup["ams"] = [];
  private readonly confirmedMatch = new Map<number, boolean>();
  private readonly notifications: Array<{ type: string; jobId: number }> = [];
  private initialRemaining = 0;
  private completions = 0;

  async setup(setup: Setup): Promise<void> {
    const trays: Tray[] = setup.ams.map((a) => ({
      index: a.slot,
      color: a.color,
      type: a.type,
      remaining_g: a.remaining_g,
    }));
    this.printer = new VirtualPrinter(
      { serial: "SUT0001", speedFactor: setup.speed_factor ?? 1000, fullSpoolGrams: 1000 },
      trays,
    );

    const { db, close } = openDb(":memory:");
    this.closeDb = close;
    this.repo = new RecordingRepo(db);
    this.amsConfig = setup.ams;

    if (setup.stocker) {
      this.repo.setStocker(setup.stocker.capacity, setup.stocker.remaining);
      this.initialRemaining = setup.stocker.remaining;
    }
    for (const [k, v] of Object.entries(setup.system_settings)) this.repo.setSetting(k, v);

    this.printerPort = new StubDirectPrinter(this.printer, (jobId) => {
      const spec = this.specByDbId.get(jobId);
      return spec?.ams_mapping ?? [-1, -1, -1, -1];
    });
    this.dispatcher = new Dispatcher(this.repo, this.printerPort);

    // stash job specs by logical id for upload()
    this.pendingSpecs = new Map(setup.jobs.map((j) => [j.id, j]));
  }

  private pendingSpecs = new Map<string, JobSpec>();

  async teardown(): Promise<void> {
    this.closeDb?.();
  }

  // ── actions ─────────────────────────────────────────────────────────────────
  async upload(logicalId: string): Promise<void> {
    const spec = this.pendingSpecs.get(logicalId);
    if (!spec) throw new Error(`scenario has no job spec for '${logicalId}'`);
    const dbId = this.repo.createJob({
      filename: logicalId,
      estimated_seconds: spec.est_seconds ?? null,
      filaments: spec.filaments,
      ams_mapping: spec.ams_mapping,
    });
    this.logicalToDbId.set(logicalId, dbId);
    this.specByDbId.set(dbId, spec);
  }

  async confirmFilaments(logicalId: string): Promise<void> {
    const dbId = this.dbId(logicalId);
    const spec = this.specByDbId.get(dbId)!;
    const matched = this.amsMatches(spec);
    this.confirmedMatch.set(dbId, matched);
    if (matched) {
      // exact match => advisory auto-queue, no blocking pending (INV-PENDING-01)
      await this.dispatcher.enqueue(dbId);
    } else {
      this.repo.createPendingAction({
        type: "filament_confirm",
        severity: "blocking_job",
        job_id: dbId,
        message: "AMS mismatch",
      });
    }
  }

  async dispatchAll(): Promise<void> {
    // single machine: one dispatch; sequential advance happens on finish.
    await this.dispatcher.dispatchNext();
  }

  async control(_method: string, path: string, body?: unknown): Promise<void> {
    const b = (body ?? {}) as Record<string, unknown>;
    const amsSlot = path.match(/\/__control\/ams\/(\d+)/);
    if (amsSlot) {
      this.printer.setAms(Number(amsSlot[1]), b as never);
    } else if (path.endsWith("/finish")) {
      this.printer.forceFinish();
    } else if (path.endsWith("/fault")) {
      this.printer.injectFault(b as never);
    }
  }

  async resolvePending(type: string): Promise<void> {
    for (const a of this.repo.getUnresolvedPendingActions()) {
      if (a.type === type) this.repo.resolvePendingAction(a.id);
    }
  }
  async retry(logicalId: string): Promise<void> {
    await this.dispatcher.retry(this.dbId(logicalId));
  }
  async refillStocker(): Promise<void> {
    this.repo.refillStocker();
  }
  async finishCurrent(): Promise<void> {
    const printing = this.repo.listByStatus("printing")[0];
    if (!printing) return;
    this.printer.forceFinish();
    await this.dispatcher.onFinished(printing.id);
    this.completions++;
    this.notifications.push({ type: "job_finished", jobId: printing.id }); // spec 15 (INV-NOTIFY-01)
  }

  // ── queries ─────────────────────────────────────────────────────────────────
  async jobState(logicalId: string): Promise<string> {
    return this.repo.getJob(this.dbId(logicalId))!.status;
  }
  async stockerRemaining(): Promise<number> {
    return this.repo.getStocker()!.remaining;
  }
  async pendingActionExists(type: string): Promise<boolean> {
    return this.repo.getUnresolvedPendingActions().some((a) => a.type === type);
  }
  async printingCount(): Promise<number> {
    return this.repo.listByStatus("printing").length;
  }

  async checkInvariant(id: string): Promise<InvariantResult> {
    switch (id) {
      case "INV-PENDING-01": {
        const bad = [...this.confirmedMatch.entries()].find(
          ([dbId, matched]) => matched && this.repo.getJob(dbId)!.status === "processing",
        );
        const blocking = this.repo
          .getUnresolvedPendingActions()
          .some((a) => a.type === "filament_confirm" && a.severity !== "advisory");
        return bad || blocking
          ? { ok: false, detail: "matched filament not auto-queued or blocking pending present" }
          : { ok: true };
      }
      case "INV-MQTT-01": {
        const bad = this.printerPort.sentMappings.find((m) => m.length !== 4);
        return bad ? { ok: false, detail: `ams_mapping length ${bad.length}` } : { ok: true };
      }
      case "INV-STOCKER-03":
      case "INV-CONSISTENCY-01": {
        const remaining = this.repo.getStocker()!.remaining;
        const expected = this.initialRemaining - this.completions;
        return remaining === expected
          ? { ok: true }
          : { ok: false, detail: `remaining ${remaining} != ${this.initialRemaining}-${this.completions}` };
      }
      case "INV-QUEUE-01": {
        const bad = this.repo.transitions.find((t) => !ALLOWED_TRANSITIONS.has(`${t.from}>${t.to}`));
        return bad ? { ok: false, detail: `illegal transition ${bad.from}->${bad.to}` } : { ok: true };
      }
      case "INV-NOTIFY-01": {
        const finishNotes = this.notifications.filter((n) => n.type === "job_finished").length;
        return finishNotes === this.completions
          ? { ok: true }
          : { ok: false, detail: `${finishNotes} finish notifications for ${this.completions} completions` };
      }
      case "INV-DISPATCH-02": {
        const positions = this.repo.printingOrder.map((dbId) => this.repo.getJob(dbId)!.position ?? 0);
        const sorted = [...positions].every((p, i) => i === 0 || positions[i - 1]! <= p);
        return sorted ? { ok: true } : { ok: false, detail: `printing order not position-ascending: ${positions}` };
      }
      case "INV-ETA-02":
      case "INV-ETA-03":
        return this.checkEta(id);
      default:
        // Fail loudly rather than silently pass — an unmechanized invariant
        // assert must drive mechanization, not false-green (no gaming).
        return { ok: false, detail: `invariant ${id} not mechanized in StubSut` };
    }
  }

  // ── internals ────────────────────────────────────────────────────────────────
  private checkEta(id: string): InvariantResult {
    const now = 1_700_000_000_000; // fixed reference; ETA structure is time-invariant
    const printing = this.repo.listByStatus("printing")[0];
    const running = printing
      ? { id: printing.id, remainingMinutes: this.printer.remainingMinutes }
      : undefined;
    const queued = this.repo
      .listByStatus("queued")
      .map((j) => ({ id: j.id, estimatedSeconds: j.estimated_seconds ?? 0 }));
    const eta = calcEta({ now, swapDurationMs: SWAP_DURATION_MS, running, queued });

    const orderedIds = [...(running ? [running.id] : []), ...queued.map((q) => q.id)];
    const seq = orderedIds.map((jid) => eta.plateEtas[jid]!);

    if (id === "INV-ETA-03") {
      const monotonic = seq.every((v, i) => i === 0 || seq[i - 1]! <= v);
      return monotonic ? { ok: true } : { ok: false, detail: `plateEtas not monotonic: ${seq}` };
    }
    // INV-ETA-02: projectEta includes one swap per plate boundary
    const n = orderedIds.length;
    const sumTimes =
      (running ? running.remainingMinutes * 60_000 : 0) +
      queued.reduce((s, q) => s + q.estimatedSeconds * 1000, 0);
    const expected = now + sumTimes + n * SWAP_DURATION_MS;
    return eta.projectEta === expected
      ? { ok: true }
      : { ok: false, detail: `projectEta ${eta.projectEta} != ${expected}` };
  }

  private amsMatches(spec: JobSpec): boolean {
    const fils = spec.filaments ?? [];
    return fils.every((f) =>
      this.amsConfig.some((a) => a.slot === f.slot && a.color === f.color && a.type === f.type),
    );
  }

  private dbId(logicalId: string): number {
    const id = this.logicalToDbId.get(logicalId);
    if (id == null) throw new Error(`job '${logicalId}' not uploaded`);
    return id;
  }
}
