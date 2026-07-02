import type { JobRow } from "../db/types.ts";
import { systemClock, type PrinterPort } from "../core/ports.ts";
import { EJECT_ARTIFACT_NAME, printerUploadPath } from "../core/artifact.ts";
import { OrchestratorMqttClient } from "./mqtt-client.ts";
import { uploadBytes, type FtpsUploadOptions } from "./ftps-client.ts";
import { throttleUploadProgress, type UploadProgressSample } from "./upload-progress-throttle.ts";
import { moduleLogger } from "../obs/default-logger.ts";

export interface PrintArtifact {
  bytes: Buffer;
  remoteName: string; // e.g. "job-12.gcode.3mf"
  param: string; // e.g. "Metadata/plate_1.gcode"
  url: string; // e.g. "ftp:///cache/job-12.gcode.3mf"
  amsMapping: number[]; // 4 elements (INV-MQTT-01)
}

/** Resolves a job into its uploadable artifact. Real 3MF injection is Phase 4;
 *  injected here so the transport (this class) stays independent of it. */
export type ArtifactResolver = (job: JobRow) => Promise<PrintArtifact> | PrintArtifact;

export interface MqttFtpsPrinterOptions {
  /** Bytes of the dedicated eject job (homing + swap only, spec 6/19). When
   *  set, ejectAndReset sends it as a normal print right after `stop`
   *  (INV-MQTT-02). When absent, ejectAndReset is stop-only (prior behavior). */
  ejectArtifact?: () => Buffer;
  /** Transfer monitor hook (upload progress indicator): called with a stable
   *  `context` ("job-{id}" for startPrint, "eject" for ejectAndReset) plus the
   *  raw {bytesSent,totalBytes} sample, already throttled (see
   *  upload-progress-throttle.ts) so a caller can forward it straight to SSE
   *  without flooding. */
  onUploadProgress?: (context: string, p: UploadProgressSample) => void;
  /** After publishing project_file, wait up to this long for the printer to
   *  actually leave IDLE (→ PREPARE/RUNNING). The ack alone is not proof of a
   *  start (実測 2026-07-03: A1 acks "success" then sets a print_error and
   *  stays IDLE). 0 disables the check. Default 20s. */
  confirmStartMs?: number;
}

/**
 * Real PrinterPort: FTPS-upload then MQTT project_file to start a print, and
 * MQTT stop (+ eject job, Phase-later) to reset. This is the dispatcher's
 * printer side (spec 6): "FTPS送信 → MQTT印刷開始".
 */
export class MqttFtpsPrinter implements PrinterPort {
  constructor(
    private readonly mqtt: OrchestratorMqttClient,
    private readonly ftps: FtpsUploadOptions,
    private readonly resolveArtifact: ArtifactResolver,
    private readonly opts: MqttFtpsPrinterOptions = {},
  ) {}

  async startPrint(job: JobRow): Promise<void> {
    const artifact = await this.resolveArtifact(job);
    if (artifact.amsMapping.length !== 4) {
      throw new Error(`ams_mapping must have exactly 4 elements (INV-MQTT-01)`);
    }
    await this.upload(artifact.bytes, artifact.remoteName, `job-${job.id}`);
    this.mqtt.publishProjectFile({
      param: artifact.param,
      url: artifact.url,
      amsMapping: artifact.amsMapping,
      sequenceId: String(job.id),
      // Explicit subtask_name = the monitor's correlation key (job-{id}.…),
      // no longer dependent on how firmware derives it from the url.
      subtaskName: artifact.remoteName,
      // A fresh plate just landed on the bed — re-level. Flow/vibration cali
      // per plate would burn minutes each swap cycle; leave them off.
      bedLeveling: true,
    });

    // Confirm the printer actually STARTED (left IDLE) — the ack is not enough.
    // If it stays IDLE (rejected the print, e.g. a filament/AMS mismatch sets a
    // print_error), throw so the dispatcher reverts the job to 'queued' instead
    // of stranding it in a phantom 'printing' (実測 2026-07-03).
    const confirmMs = this.opts.confirmStartMs ?? 20_000;
    if (confirmMs > 0) {
      const started = await this.mqtt.waitForStatus((s) => s.gcodeState !== "IDLE", confirmMs);
      if (!started) {
        throw new Error(
          `printer accepted the command but did not start within ${Math.round(confirmMs / 1000)}s ` +
            `(still IDLE — likely a print_error; check the printer screen / filament mapping)`,
        );
      }
    }
  }

  /** spec 6/9 abnormal path + INV-MQTT-02: `stop`, then send the dedicated
   *  eject job (homing + swap only) as a normal print so the mechanism ends in
   *  a safe state. Ordering is guaranteed by MQTT: stop and project_file go
   *  out on the same connection in publish order (and the FTPS upload sits
   *  between them), so the printer has left RUNNING before the eject arrives.
   *
   *  TODO(spec 19 / Phase 8): the eject print itself takes real time — before
   *  multi-machine or tighter sequencing, the dispatcher should wait for the
   *  eject's FINISH (via the monitor) before starting the next queued plate. */
  async ejectAndReset(): Promise<void> {
    this.mqtt.stop();
    const eject = this.opts.ejectArtifact?.();
    if (!eject) return; // no eject artifact configured — stop-only
    await this.upload(eject, EJECT_ARTIFACT_NAME, "eject");
    this.mqtt.publishProjectFile({
      param: "Metadata/plate_1.gcode",
      url: `ftp:///cache/${EJECT_ARTIFACT_NAME}`,
      amsMapping: [-1, -1, -1, -1], // no filament use — motion only
      useAms: false,
      sequenceId: "eject",
      subtaskName: EJECT_ARTIFACT_NAME, // outside job-{id} → never attributed to a queue row
      // motion-only recovery: no calibration of any kind
    });
  }

  async resumeWithAlternateSlot(jobId: number, slot: number): Promise<void> {
    // TODO(spec 14/16): exact MQTT resume-on-alternate-slot command is unverified
    // against real hardware. Until confirmed this is a no-op — warn loudly so a
    // runout "auto-switch" that didn't actually happen is visible in the logs,
    // not silently reported as success.
    moduleLogger("printer").warn("resumeWithAlternateSlot is NOT implemented — print stays paused", {
      event: "printer_resume_unimplemented",
      jobId,
      slot,
      reason: "spec 19 unverified MQTT command",
    });
  }

  /** FTPS-upload the artifact to the printer cache. Protected so tests can
   *  override it for a hermetic start-confirmation unit test. */
  protected async upload(bytes: Buffer, remoteName: string, context: string): Promise<void> {
    await uploadBytes(
      { ...this.ftps, onProgress: this.uploadProgressHook(context) },
      bytes,
      printerUploadPath(remoteName),
    );
  }

  /** Builds a throttled onProgress hook for one upload (fresh state per call —
   *  each uploadBytes() invocation is its own transfer), or undefined when no
   *  consumer is wired (uploadBytes then runs with no per-chunk overhead). */
  private uploadProgressHook(context: string): ((p: UploadProgressSample) => void) | undefined {
    const sink = this.opts.onUploadProgress;
    if (!sink) return undefined;
    return throttleUploadProgress((p) => sink(context, p), systemClock);
  }
}
