import mqtt, { type MqttClient as MqttConn } from "mqtt";
import { EventEmitter } from "node:events";
import { reportTopic, requestTopic } from "../protocol/topics.ts";
import { pushStatusSchema } from "./report-schema.ts";

/** Normalized printer status the orchestrator consumes (from push_status). */
export interface PrinterStatus {
  gcodeState: string;
  mcRemainingTime: number; // minutes (spec 9 mc_remaining_time)
  mcPercent: number;
  subtaskName: string;
  /** Layer progress (0 when the artifact carries no slice metadata, e.g. the
   *  dry-rehearsal 3mf). layerNum >= totalLayerNum (>0) while RUNNING means
   *  the print body is done and the appended end/swap sequence is next. */
  layerNum: number;
  totalLayerNum: number;
  hms: Array<{ attr: number; code: number }>;
}

export interface ProjectFileParams {
  param: string; // e.g. "Metadata/plate_1.gcode"
  url: string; // e.g. "ftp:///cache/{id}.gcode.3mf"
  amsMapping: number[]; // MUST be 4 elements (INV-MQTT-01)
  useAms?: boolean;
  sequenceId?: string;
  /** Echoed back by the firmware as subtask_name — the monitor's correlation
   *  key. 実測 2026-07-02: explicitly setting it is accepted by real firmware
   *  (probe V1) and makes correlation independent of the url basename. */
  subtaskName?: string;
  /** Calibration/aux flags (spec 9). All default false — the dry-rehearsal /
   *  eject jobs must not calibrate; real plate prints opt in per job. The
   *  实測-proven command shape includes these fields explicitly. */
  bedLeveling?: boolean;
  flowCali?: boolean;
  vibrationCali?: boolean;
  timelapse?: boolean;
  layerInspect?: boolean;
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
      // Always log command acks — a rejected project_file used to fail in
      // total silence (実測 2026-07-02: the Stage 5 "uploaded but nothing
      // happens" hour). Low volume: one line per command sent.
      console.log(
        `[mqtt] ack ${String(p.command)} → ${p.result}` +
          (p.reason !== undefined && p.reason !== p.result ? ` (reason=${String(p.reason)})` : ""),
      );
      this.emit("ack", { command: p.command, result: p.result, sequenceId: p.sequence_id, reason: p.reason });
      return;
    }
    if (p.gcode_state !== undefined) {
      // Boundary validation (report-schema.ts): lenient scalar coercion, but
      // hms entries are checked instead of blindly cast, and NaN degrades to 0.
      const parsed = pushStatusSchema.safeParse(p);
      if (!parsed.success) return; // unparseable report: skip, keep last status
      const status: PrinterStatus = {
        gcodeState: parsed.data.gcode_state,
        mcRemainingTime: parsed.data.mc_remaining_time,
        mcPercent: parsed.data.mc_percent,
        subtaskName: parsed.data.subtask_name,
        layerNum: parsed.data.layer_num,
        totalLayerNum: parsed.data.total_layer_num,
        hms: parsed.data.hms,
      };
      this.latestStatus = status;
      this.emit("status", status);
    }
  }

  /** Resolve with the first status matching `pred`, or null on timeout. Used to
   *  confirm the printer actually acted on a command (e.g. left IDLE after a
   *  project_file) instead of trusting the ack alone (実測 2026-07-03: the A1
   *  acks project_file "success" then sets a print_error and stays IDLE). */
  waitForStatus(pred: (s: PrinterStatus) => boolean, timeoutMs: number): Promise<PrinterStatus | null> {
    return new Promise((resolve) => {
      const onStatus = (s: PrinterStatus) => {
        if (pred(s)) {
          cleanup();
          resolve(s);
        }
      };
      const timer = setTimeout(() => {
        cleanup();
        resolve(null);
      }, timeoutMs);
      const cleanup = () => {
        this.off("status", onStatus);
        clearTimeout(timer);
      };
      this.on("status", onStatus);
    });
  }

  publishProjectFile(params: ProjectFileParams): void {
    // Field set proven against real firmware (実測 2026-07-02 probe V1:
    // ack success → PREPARE → RUNNING with exactly this shape).
    this.publish({
      print: {
        command: "project_file",
        sequence_id: params.sequenceId ?? "0",
        param: params.param,
        url: params.url,
        ...(params.subtaskName !== undefined ? { subtask_name: params.subtaskName } : {}),
        use_ams: params.useAms ?? true,
        ams_mapping: params.amsMapping,
        timelapse: params.timelapse ?? false,
        bed_leveling: params.bedLeveling ?? false,
        flow_cali: params.flowCali ?? false,
        vibration_cali: params.vibrationCali ?? false,
        layer_inspect: params.layerInspect ?? false,
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
