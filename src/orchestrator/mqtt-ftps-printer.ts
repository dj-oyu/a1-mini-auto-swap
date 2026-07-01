import type { JobRow } from "../db/types.ts";
import type { PrinterPort } from "../core/ports.ts";
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

  async ejectAndReset(): Promise<void> {
    this.mqtt.stop();
    // TODO(spec 6/19): after stop, dispatch the dedicated eject job (homing +
    // swap sequence) as a normal print. The eject 3mf is a pre-made artifact
    // (spec 19 open item). For now stop() drives the printer toward IDLE.
  }
}
