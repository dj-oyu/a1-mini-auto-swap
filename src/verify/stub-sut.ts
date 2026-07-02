import { openDb } from "../db/index.ts";
import { Repo } from "../db/repo.ts";
import type { Database } from "bun:sqlite";
import type { JobRow, JobStatus } from "../db/types.ts";
import { Dispatcher } from "../core/dispatcher.ts";
import type { Notifier, NotifyEvent, PrinterPort } from "../core/ports.ts";
import { calcEta } from "../core/eta.ts";
import { amsMatches } from "../core/ams.ts";
import { FilamentService } from "../core/filament-service.ts";
import type { AmsTray } from "../core/runout.ts";
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
  /** eject jobs sent (dispatcher.onFailed/abort) — INV-FAIL-01. */
  ejects = 0;
  /** alternate-slot resumes requested by the FilamentService — INV-RUNOUT-04/06. */
  readonly resumes: Array<{ jobId: number; toSlot: number }> = [];
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
    this.ejects++;
    this.printer.stop();
  }
  async resumeWithAlternateSlot(jobId: number, toSlot: number): Promise<void> {
    this.resumes.push({ jobId, toSlot });
  }
}

/** Notifier adapter that records events for invariant checks (INV-NOTIFY-01). */
class RecordingNotifier implements Notifier {
  readonly events: NotifyEvent[] = [];
  notify(e: NotifyEvent): void {
    this.events.push(e);
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

  private filamentService!: FilamentService;
  private readonly logicalToDbId = new Map<string, number>();
  private readonly specByDbId = new Map<number, JobSpec>();
  private readonly projectNameToId = new Map<string, number>();
  private amsConfig: Setup["ams"] = [];
  private amsState: AmsTray[] = [];
  private readonly confirmedMatch = new Map<number, boolean>();
  private readonly notifier = new RecordingNotifier();
  private initialRemaining = 0;
  private completions = 0;
  /** Tray snapshot at the moment each runout fired — the "from" side that
   *  INV-RUNOUT-04/06 compare the switch target against. */
  private readonly runouts: Array<{ jobId: number; slot: number; color: string; type: string }> = [];

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
    this.amsState = setup.ams.map((a) => ({ ...a }));

    if (setup.project) {
      this.projectNameToId.set(
        setup.project.name,
        this.repo.createProject(setup.project.name, setup.project.color_consistency_policy),
      );
    }
    if (setup.stocker) {
      this.repo.setStocker(setup.stocker.capacity, setup.stocker.remaining);
      this.initialRemaining = setup.stocker.remaining;
    }
    for (const [k, v] of Object.entries(setup.system_settings)) this.repo.setSetting(k, v);

    this.printerPort = new StubDirectPrinter(this.printer, (jobId) => {
      const spec = this.specByDbId.get(jobId);
      return spec?.ams_mapping ?? [-1, -1, -1, -1];
    });
    this.dispatcher = new Dispatcher(this.repo, this.printerPort, { notifier: this.notifier });
    this.filamentService = new FilamentService(
      this.repo,
      { getTrays: () => this.amsState },
      this.printerPort,
      { minThresholdG: 10, notifier: this.notifier },
    );

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
      project_id: spec.project ? (this.projectNameToId.get(spec.project) ?? null) : null,
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
    const matched = amsMatches(spec.filaments ?? [], this.amsConfig);
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
      const slot = Number(amsSlot[1]);
      const before = this.amsState.find((t) => t.slot === slot);
      this.applyAmsPatch(slot, b);
      this.printer.setAms(slot, b as never);
      // A slot emptied during a print => runout: the orchestrator (here, the
      // monitor stand-in) invokes the FilamentService (spec 14).
      if (b.remaining_g === 0) {
        const printing = this.repo.listByStatus("printing")[0];
        if (printing) {
          this.runouts.push({
            jobId: printing.id,
            slot,
            color: before?.color ?? "",
            type: before?.type ?? "",
          });
          await this.filamentService.onRunout(printing.id, slot);
        }
      }
    } else if (path.endsWith("/finish")) {
      this.printer.forceFinish();
    } else if (path.endsWith("/fault")) {
      this.printer.injectFault(b as never);
      // A fault that fails the print => monitor routes it to onFailed.
      if (this.printer.state === "FAILED") {
        const printing = this.repo.listByStatus("printing")[0];
        if (printing) await this.dispatcher.onFailed(printing.id, `fault:${String(b.category)}`);
      }
    }
  }

  private applyAmsPatch(slot: number, b: Record<string, unknown>): void {
    const tray = this.amsState.find((t) => t.slot === slot);
    const patch = {
      ...(typeof b.color === "string" ? { color: b.color } : {}),
      ...(typeof b.type === "string" ? { type: b.type } : {}),
      ...(typeof b.remaining_g === "number" ? { remaining_g: b.remaining_g } : {}),
    };
    if (tray) Object.assign(tray, patch);
    else this.amsState.push({ slot, color: "", type: "", remaining_g: 0, ...patch });
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
    await this.dispatcher.onFinished(printing.id); // dispatcher emits job_finished via notifier
    this.completions++;
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
        const finishNotes = this.notifier.events.filter((n) => n.type === "job_finished").length;
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

      // ── Phase 5 (異常系) ──
      case "INV-RUNOUT-01": {
        // manual runout => filament_runout pending AND no auto-substitution
        const pending = this.pendingExists("filament_runout");
        const substituted = this.allJobs().some((j) => j.substituted_color != null);
        return pending && !substituted
          ? { ok: true }
          : { ok: false, detail: `pending=${pending} substituted=${substituted}` };
      }
      case "INV-RUNOUT-05":
        return this.pendingExists("filament_runout")
          ? { ok: true }
          : { ok: false, detail: "no filament_runout pending" };
      case "INV-RUNOUT-04": {
        // every auto-switch landed on a same-material-type slot (spec 14 Tier 2)
        if (this.printerPort.resumes.length === 0)
          return { ok: false, detail: "no alternate-slot switch occurred" };
        for (const r of this.printerPort.resumes) {
          const runout = [...this.runouts].reverse().find((e) => e.jobId === r.jobId);
          const target = this.amsState.find((t) => t.slot === r.toSlot);
          if (!runout || !target) return { ok: false, detail: `switch to slot ${r.toSlot} has no runout/target record` };
          if (target.type !== runout.type)
            return { ok: false, detail: `switched ${runout.type} -> ${target.type} (slot ${r.toSlot})` };
        }
        return { ok: true };
      }
      case "INV-RUNOUT-06": {
        // substituted_slot/color recorded IFF the switch target's color differs
        if (this.printerPort.resumes.length === 0)
          return { ok: false, detail: "no alternate-slot switch occurred" };
        for (const r of this.printerPort.resumes) {
          const runout = [...this.runouts].reverse().find((e) => e.jobId === r.jobId);
          const target = this.amsState.find((t) => t.slot === r.toSlot);
          const job = this.repo.getJob(r.jobId);
          if (!runout || !target || !job) return { ok: false, detail: `incomplete records for job ${r.jobId}` };
          const colorDiffers = target.color !== runout.color;
          const recorded = job.substituted_color != null;
          if (colorDiffers && (!recorded || job.substituted_slot !== r.toSlot || job.substituted_color !== target.color))
            return { ok: false, detail: `color差分あり(${runout.color}->${target.color})なのに記録が ${job.substituted_slot}/${job.substituted_color}` };
          if (!colorDiffers && recorded)
            return { ok: false, detail: `同色切替なのに substituted_color=${job.substituted_color} が記録された` };
        }
        return { ok: true };
      }
      case "INV-PROJECT-01": {
        // strict: color_decision pending exists AND the same project's remaining
        // plates are actually held (not printing; still queued)
        const cd = this.repo
          .getUnresolvedPendingActions()
          .find((a) => a.type === "color_decision" && a.project_id != null);
        if (!cd) return { ok: false, detail: "no color_decision pending" };
        const rest = this.allJobs().filter((j) => j.project_id === cd.project_id && j.id !== cd.job_id);
        const leaked = rest.find((j) => j.status === "printing");
        if (leaked) return { ok: false, detail: `project job ${leaked.id} dispatched while color_decision unresolved` };
        return rest.some((j) => j.status === "queued")
          ? { ok: true }
          : { ok: false, detail: "no same-project job held in 'queued'" };
      }
      case "INV-PROJECT-02": {
        const finished = this.allJobs().find(
          (j) => j.status === "success" && j.substituted_color != null && j.project_id != null,
        );
        if (!finished) return { ok: false, detail: "no finished substituted project plate" };
        const others = this.allJobs().filter(
          (j) => j.project_id === finished.project_id && j.id !== finished.id,
        );
        return others.length > 0 && others.every((j) => j.substituted_color != null)
          ? { ok: true }
          : { ok: false, detail: "remaining project plates not all substituted" };
      }
      case "INV-FAIL-01": {
        const failed = this.allJobs().some((j) => j.status === "failed");
        const ejected = this.printerPort.ejects > 0; // safe-eject job was actually sent
        return failed && ejected && this.pendingExists("retry_decision")
          ? { ok: true }
          : {
              ok: false,
              detail: `failed=${failed} ejects=${this.printerPort.ejects} retry_decision=${this.pendingExists("retry_decision")}`,
            };
      }
      case "INV-STOCKER-04": {
        const refill = this.repo
          .getUnresolvedPendingActions()
          .some((a) => a.type === "stocker_refill" && a.severity === "blocking_queue");
        const idle = this.repo.listByStatus("printing").length === 0;
        return refill && idle
          ? { ok: true }
          : { ok: false, detail: `stocker_refill=${refill} printing_idle=${idle}` };
      }

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

  private allJobs() {
    return [...this.logicalToDbId.values()].map((id) => this.repo.getJob(id)!);
  }

  private pendingExists(type: string): boolean {
    return this.repo.getUnresolvedPendingActions().some((a) => a.type === type);
  }

  private dbId(logicalId: string): number {
    const id = this.logicalToDbId.get(logicalId);
    if (id == null) throw new Error(`job '${logicalId}' not uploaded`);
    return id;
  }
}
