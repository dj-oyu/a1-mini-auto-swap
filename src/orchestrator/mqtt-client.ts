import mqtt, { type MqttClient as MqttConn } from "mqtt";
import { EventEmitter } from "node:events";
import { reportTopic, requestTopic } from "../protocol/topics.ts";

/** Normalized printer status the orchestrator consumes (from push_status). */
export interface PrinterStatus {
  gcodeState: string;
  mcRemainingTime: number; // minutes (spec 9 mc_remaining_time)
  mcPercent: number;
  subtaskName: string;
  hms: Array<{ attr: number; code: number }>;
}

export interface ProjectFileParams {
  param: string; // e.g. "Metadata/plate_1.gcode"
  url: string; // e.g. "ftp:///cache/{id}.gcode.3mf"
  amsMapping: number[]; // MUST be 4 elements (INV-MQTT-01)
  useAms?: boolean;
  sequenceId?: string;
}

export interface MqttClientOptions {
  url: string; // mqtts://host:port
  serial: string;
  accessCode: string;
  username?: string; // default "bblp"
}

/**
 * Orchestrator-side MQTT client to a printer (or the stub). Subscribes to the
 * report topic, normalizes push_status into PrinterStatus, and publishes
 * project_file / stop / pushall on the request topic. On every (re)connect it
 * subscribes and immediately full-polls (pushall) so a missed FINISH is
 * recovered after a reconnect (INV-RESYNC-02).
 */
export class OrchestratorMqttClient extends EventEmitter {
  private conn: MqttConn | null = null;
  private readonly serial: string;
  private latestStatus: PrinterStatus | null = null;
  private connectedOnce = false;

  constructor(private readonly opts: MqttClientOptions) {
    super();
    this.serial = opts.serial;
  }

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const conn = mqtt.connect(this.opts.url, {
        username: this.opts.username ?? "bblp",
        password: this.opts.accessCode,
        rejectUnauthorized: false, // spec 2: cert verification disabled
        reconnectPeriod: 1000,
      });
      this.conn = conn;

      conn.on("connect", () => {
        conn.subscribe(reportTopic(this.serial), (err) => {
          if (err) {
            if (!this.connectedOnce) reject(err);
            return;
          }
          this.pushAll(); // recover missed state on (re)connect (INV-RESYNC-02)
          if (!this.connectedOnce) {
            this.connectedOnce = true;
            resolve();
          }
        });
      });
      conn.on("message", (_topic, payload) => this.onMessage(payload));
      conn.on("error", (e) => {
        if (!this.connectedOnce) reject(e);
        else this.emit("error", e);
      });
    });
  }

  private onMessage(payload: Buffer): void {
    let msg: { print?: Record<string, unknown> };
    try {
      msg = JSON.parse(payload.toString());
    } catch {
      return;
    }
    const p = msg.print;
    if (!p) return;

    if (typeof p.result === "string") {
      this.emit("ack", { command: p.command, result: p.result, sequenceId: p.sequence_id });
      return;
    }
    if (p.gcode_state !== undefined) {
      const status: PrinterStatus = {
        gcodeState: String(p.gcode_state),
        mcRemainingTime: Number(p.mc_remaining_time ?? 0),
        mcPercent: Number(p.mc_percent ?? 0),
        subtaskName: String(p.subtask_name ?? ""),
        hms: Array.isArray(p.hms) ? (p.hms as Array<{ attr: number; code: number }>) : [],
      };
      this.latestStatus = status;
      this.emit("status", status);
    }
  }

  publishProjectFile(params: ProjectFileParams): void {
    this.publish({
      print: {
        command: "project_file",
        sequence_id: params.sequenceId ?? "0",
        param: params.param,
        url: params.url,
        use_ams: params.useAms ?? true,
        ams_mapping: params.amsMapping,
      },
    });
  }
  stop(): void {
    this.publish({ print: { command: "stop" } });
  }
  pushAll(): void {
    this.publish({ pushing: { command: "pushall" } });
  }
  latest(): PrinterStatus | null {
    return this.latestStatus;
  }

  private publish(obj: unknown): void {
    this.conn?.publish(requestTopic(this.serial), JSON.stringify(obj));
  }

  close(): Promise<void> {
    return new Promise((resolve) => {
      if (this.conn) this.conn.end(true, {}, () => resolve());
      else resolve();
    });
  }
}
