import type { JobRow } from "../db/types.ts";
import type { PrinterPort } from "../core/ports.ts";
import { EJECT_ARTIFACT_NAME } from "../core/artifact.ts";
import { OrchestratorMqttClient } from "./mqtt-client.ts";
import { uploadBytes, type FtpsUploadOptions } from "./ftps-client.ts";

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
    await uploadBytes(this.ftps, artifact.bytes, artifact.remoteName);
    this.mqtt.publishProjectFile({
      param: artifact.param,
      url: artifact.url,
      amsMapping: artifact.amsMapping,
      sequenceId: String(job.id),
    });
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
    await uploadBytes(this.ftps, eject, EJECT_ARTIFACT_NAME);
    this.mqtt.publishProjectFile({
      param: "Metadata/plate_1.gcode",
      url: `ftp:///cache/${EJECT_ARTIFACT_NAME}`,
      amsMapping: [-1, -1, -1, -1], // no filament use — motion only
      useAms: false,
      sequenceId: "eject",
    });
  }

  async resumeWithAlternateSlot(jobId: number, slot: number): Promise<void> {
    // TODO(spec 14/16): exact MQTT resume-on-alternate-slot command is unverified
    // against real hardware. Until confirmed this is a no-op — warn loudly so a
    // runout "auto-switch" that didn't actually happen is visible in the logs,
    // not silently reported as success.
    console.warn(
      `[printer] resumeWithAlternateSlot(job=${jobId}, slot=${slot}) is NOT implemented ` +
        `(spec 19 unverified MQTT command) — the print will stay paused on the printer`,
    );
  }
}
