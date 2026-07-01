import { EventEmitter } from "node:events";
import type {
  ActiveJob,
  FaultInjection,
  GcodeState,
  HmsError,
  ProjectFileCommand,
  StatusReport,
  Tray,
  VirtualPrinterConfig,
} from "./types.ts";

/** Generic HMS codes used by the stub for injected faults. Not real Bambu
 *  codes — the orchestrator only needs *a* code to route retry_decision. */
export const HMS = {
  PRINTER_FAULT: 0x0c00_0001,
  SWAP_FAULT: 0x0c00_0002,
  FILAMENT_RUNOUT: 0x0700_0001,
} as const;

/**
 * Protocol-agnostic A1 mini virtual printer state machine (spec 20.3).
 *
 * Pure logic, no sockets and no timers: progress is advanced by callers via
 * tick()/forceFinish(). This separation is what makes the verify mechanism
 * deterministic — tests advance state explicitly instead of racing wall-clock
 * (see scenarios/README.md `finish_current`).
 *
 * Emits `"report"` (StatusReport) whenever observable state changes, except
 * when a FINISH report is intentionally suppressed to reproduce the missed-
 * FINISH disconnect (spec 20.5, INV-RESYNC-01). A full-status poll (pushall)
 * always reflects true state regardless of suppression.
 */
export class VirtualPrinter extends EventEmitter {
  readonly serial: string;
  private speedFactor: number;
  private readonly fullSpoolGrams: number;

  private gcodeState: GcodeState = "IDLE";
  private mcRemainingTime = 0;
  private mcPercent = 0;
  private layerNum = 0;
  private totalLayerNum = 0;
  private nozzleTemper = 25;
  private bedTemper = 25;
  private lastSequenceId = "0";

  private activeJob: ActiveJob | null = null;
  private trays: Tray[] = [];
  private hms: HmsError[] = [];

  private pendingFault: FaultInjection | null = null;
  /** set when a FINISH report must be withheld (missed-FINISH reproduction) */
  private finishReportSuppressed = false;

  constructor(config: VirtualPrinterConfig, initialTrays: Tray[] = []) {
    super();
    this.serial = config.serial;
    this.speedFactor = config.speedFactor;
    this.fullSpoolGrams = config.fullSpoolGrams;
    this.trays = initialTrays.map((t) => ({ ...t }));
  }

  // ── observation ──────────────────────────────────────────────────────────

  get state(): GcodeState {
    return this.gcodeState;
  }

  get remainingMinutes(): number {
    return this.mcRemainingTime;
  }

  get currentSpeedFactor(): number {
    return this.speedFactor;
  }

  /** Interval (ms) between simulated ticks for the current speed factor. */
  get tickIntervalMs(): number {
    return Math.max(1, Math.round(60_000 / this.speedFactor));
  }

  /** Build the current status report (always reflects true state). */
  buildReport(): StatusReport {
    return {
      print: {
        command: "push_status",
        msg: 0,
        gcode_state: this.gcodeState,
        mc_print_stage: this.gcodeState === "RUNNING" ? "2" : "-1",
        mc_remaining_time: this.mcRemainingTime,
        mc_percent: this.mcPercent,
        layer_num: this.layerNum,
        total_layer_num: this.totalLayerNum,
        subtask_name: this.activeJob?.subtask_name ?? "",
        nozzle_temper: this.nozzleTemper,
        bed_temper: this.bedTemper,
        ams: {
          ams: [
            {
              id: "0",
              humidity: "5",
              temp: "30.0",
              tray: this.trays.map((t) => ({
                id: String(t.index),
                tray_color: t.color,
                tray_type: t.type,
                remain: this.gramsToRemainPercent(t),
              })),
            },
          ],
          ams_exist_bits: "1",
          tray_exist_bits: this.trayExistBits(),
          tray_now: this.activeTray(),
          tray_tar: this.activeTray(),
        },
        hms: this.hms.map((h) => ({ ...h })),
        sequence_id: this.lastSequenceId,
      },
    };
  }

  /** Hex bitfield of trays that currently hold filament (remaining_g > 0). */
  private trayExistBits(): string {
    let bits = 0;
    for (const t of this.trays) {
      if (t.remaining_g > 0 && t.index >= 0 && t.index < 4) bits |= 1 << t.index;
    }
    return bits.toString(16);
  }

  /** Loaded tray id derived from the active job's ams_mapping, else "255". */
  private activeTray(): string {
    const mapping = this.activeJob?.ams_mapping;
    if (!mapping) return "255";
    const slot = mapping.find((m) => m >= 0);
    return slot === undefined ? "255" : String(slot);
  }

  // ── commands (MQTT side) ───────────────────────────────────────────────────

  /**
   * Handle an incoming `print`/project_file command (spec 9).
   * Returns an error string if rejected, or null on accept.
   */
  receiveProjectFile(cmd: ProjectFileCommand): string | null {
    if (this.gcodeState === "RUNNING" || this.gcodeState === "PREPARE") {
      return "printer busy";
    }
    if (!Array.isArray(cmd.ams_mapping) || cmd.ams_mapping.length !== 4) {
      // spec 9 / INV-MQTT-01: 5-element mapping is the known external-spool trap.
      return "ams_mapping must have exactly 4 elements";
    }
    this.lastSequenceId = cmd.sequence_id ?? this.lastSequenceId;

    const totalMinutes = 10; // default sim length; overridable via __control
    this.activeJob = {
      subtask_name: deriveSubtaskName(cmd.url, cmd.param),
      param: cmd.param,
      url: cmd.url,
      ams_mapping: [...cmd.ams_mapping],
      totalMinutes,
    };
    this.hms = [];
    this.finishReportSuppressed = false;

    // PREPARE → RUNNING
    this.transition("PREPARE");
    this.mcRemainingTime = totalMinutes;
    this.totalLayerNum = totalMinutes; // 1 sim-layer per sim-minute, good enough
    this.layerNum = 0;
    this.mcPercent = 0;
    this.nozzleTemper = 220;
    this.bedTemper = 60;
    this.transition("RUNNING");

    // swap-system fault: force the just-dispatched print to fail (spec 20.5).
    if (this.pendingFault && this.pendingFault.timing === "next_print") {
      const isSwap = this.pendingFault.category === "swap";
      this.pendingFault = null;
      this.forceFail(isSwap ? HMS.SWAP_FAULT : HMS.PRINTER_FAULT);
    }
    return null;
  }

  /** `stop` command (spec 9): abort the running print. */
  stop(): void {
    if (this.gcodeState !== "RUNNING" && this.gcodeState !== "PAUSE") return;
    this.forceFail(HMS.PRINTER_FAULT, /* aborted */ true);
  }

  /** Return an idle printer to IDLE after a terminal state was observed.
   *  Clears HMS (an idle printer must not advertise a prior fault) and lifts
   *  any FINISH-report suppression so the IDLE transition is actually emitted
   *  even right after a missed-FINISH (both were caught by edge tests). */
  reset(): void {
    this.activeJob = null;
    this.mcRemainingTime = 0;
    this.mcPercent = 0;
    this.layerNum = 0;
    this.totalLayerNum = 0;
    this.nozzleTemper = 25;
    this.bedTemper = 25;
    this.hms = [];
    this.finishReportSuppressed = false;
    this.transition("IDLE");
  }

  // ── progress (driven externally — no internal timer) ───────────────────────

  /** Advance one simulated minute. No-op unless RUNNING. */
  tick(): void {
    if (this.gcodeState !== "RUNNING") return;
    this.mcRemainingTime = Math.max(0, this.mcRemainingTime - 1);
    const total = this.activeJob?.totalMinutes ?? 1;
    const elapsed = total - this.mcRemainingTime;
    this.mcPercent = Math.min(100, Math.round((elapsed / total) * 100));
    this.layerNum = Math.min(this.totalLayerNum, elapsed);
    if (this.mcRemainingTime <= 0) {
      this.handleFinish();
    } else {
      this.publish();
    }
  }

  /** Jump straight to completion (the __control finish shortcut). */
  forceFinish(): void {
    if (this.gcodeState !== "RUNNING" && this.gcodeState !== "PREPARE") return;
    this.mcRemainingTime = 0;
    this.mcPercent = 100;
    this.layerNum = this.totalLayerNum;
    this.handleFinish();
  }

  /** Jump straight to FAILED with an HMS code. */
  forceFail(code: number = HMS.PRINTER_FAULT, aborted = false): void {
    this.hms = [{ attr: 0, code }];
    this.mcRemainingTime = 0;
    void aborted; // reserved: abort vs spontaneous fail are reported identically
    this.transition("FAILED");
    this.publish();
  }

  // ── control backdoor (spec 20.4 / 20.5) ────────────────────────────────────

  setAms(slot: number, patch: Partial<Omit<Tray, "index">>): void {
    const existing = this.trays.find((t) => t.index === slot);
    if (existing) {
      Object.assign(existing, patch);
    } else {
      this.trays.push({
        index: slot,
        color: patch.color ?? "",
        type: patch.type ?? "",
        remaining_g: patch.remaining_g ?? 0,
      });
      this.trays.sort((a, b) => a.index - b.index);
    }
    this.publish();
  }

  setSpeedFactor(factor: number): void {
    if (factor > 0) this.speedFactor = factor;
  }

  /** Set the total simulated minutes for the *next/current* print. */
  setPrintMinutes(minutes: number): void {
    if (this.activeJob) {
      this.activeJob.totalMinutes = minutes;
      this.totalLayerNum = minutes;
      if (this.gcodeState === "RUNNING") this.mcRemainingTime = minutes;
    }
  }

  injectFault(fault: FaultInjection): void {
    if (fault.timing === "now") {
      const code =
        fault.category === "swap" ? HMS.SWAP_FAULT : HMS.PRINTER_FAULT;
      if (this.gcodeState === "RUNNING" || this.gcodeState === "PREPARE") {
        this.forceFail(code);
      } else {
        this.hms = [{ attr: 0, code }];
        this.publish();
      }
      return;
    }
    this.pendingFault = fault; // applied later (next_print / on FINISH)
  }

  /**
   * Full-status poll, i.e. the orchestrator's pushall on (re)connect.
   * ALWAYS emits the true current state, even if a FINISH report was
   * previously suppressed — this is the resync hook (spec 20.5, INV-RESYNC-02).
   */
  pushAll(): StatusReport {
    this.finishReportSuppressed = false;
    const report = this.buildReport();
    this.emit("report", report);
    return report;
  }

  // ── internals ──────────────────────────────────────────────────────────────

  private handleFinish(): void {
    const suppress =
      this.pendingFault?.timing === "on_state_transition:FINISH";
    this.mcPercent = 100;
    this.mcRemainingTime = 0;
    this.transition("FINISH", /* silent */ suppress);
    if (suppress) {
      // missed-FINISH reproduction: state really is FINISH, but no report goes
      // out. Only a pushAll() (full re-poll) will surface it. (spec 20.5)
      this.pendingFault = null;
      this.finishReportSuppressed = true;
    }
  }

  private transition(next: GcodeState, silent = false): void {
    this.gcodeState = next;
    if (!silent) this.publish();
  }

  private publish(): void {
    if (this.finishReportSuppressed) return;
    this.emit("report", this.buildReport());
  }

  private gramsToRemainPercent(t: Tray): number {
    if (t.type === "" && t.remaining_g === 0) return -1;
    return Math.max(0, Math.min(100, Math.round((t.remaining_g / this.fullSpoolGrams) * 100)));
  }
}

function deriveSubtaskName(url: string, param: string): string {
  const fromUrl = url.split("/").pop();
  if (fromUrl && fromUrl.length > 0) return fromUrl;
  return param;
}
