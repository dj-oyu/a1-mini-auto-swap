import net from "node:net";
import mqtt from "mqtt";
import { type Client as FtpClient, FTPError } from "basic-ftp";
import { reportTopic, requestTopic } from "../protocol/topics.ts";
import { withFtpsSession } from "./ftps-session.ts";

/**
 * Connectivity diagnostics (spec 20.7): a single, side-effect-free probe that
 * works against BOTH the printer-stub and a real A1 mini, so switching to real
 * hardware (Phase 8) can be triaged fast. Every individual check is
 * time-boxed and NEVER throws — a failure is a normal, structured result, not
 * an exception. Secrets are never logged or echoed: the access code is used
 * only as a credential and never placed into the result.
 */
export interface DiagnosticsOptions {
  host: string;
  mqttPort: number;
  ftpsPort: number;
  serial: string;
  accessCode: string;
  username?: string; // default "bblp"
  timeoutMs?: number; // per-check budget, default 3000
}

export type ProtMode = "P" | "C" | "none";

export interface DiagnosticsResult {
  host: string;
  /** Raw TCP connect succeeded to the MQTT / FTPS port. */
  mqtt_reachable: boolean;
  ftps_reachable: boolean;
  /** MQTTS CONNECT accepted (username + access code as password, spec 2). */
  mqtt_auth_ok: boolean;
  /** A push_status report arrived after subscribing + pushall. */
  report_received: boolean;
  /** implicit-FTPS login (USER bblp / PASS access code) succeeded. */
  ftps_auth_ok: boolean;
  /** Data-channel protection the server accepts: PROT P, else C, else none
   *  (spec 19 unverified item — the A1 PROT C fallback). */
  prot_mode: ProtMode;
  /** Human-readable trace of the PROT probe response codes. */
  prot_detail: string | null;
  /** The raw `print` block of the received report — evidence for real-hardware
   *  investigation. Never contains the access code. */
  sample_report: Record<string, unknown> | null;
  /** Reason strings for whichever checks failed (never contains secrets). */
  errors: Record<string, string>;
}

/** Run every probe concurrently and assemble a structured verdict. */
export async function runDiagnostics(opts: DiagnosticsOptions): Promise<DiagnosticsResult> {
  const timeoutMs = opts.timeoutMs ?? 3000;
  const username = opts.username ?? "bblp";
  const cfg = { ...opts, timeoutMs, username };

  const [mqttReach, ftpsReach, mqttRes, ftpsRes] = await Promise.all([
    tcpReachable(opts.host, opts.mqttPort, timeoutMs),
    tcpReachable(opts.host, opts.ftpsPort, timeoutMs),
    checkMqtt(cfg),
    checkFtps(cfg),
  ]);

  const errors: Record<string, string> = {};
  if (mqttReach.error) errors.mqtt_reachable = mqttReach.error;
  if (ftpsReach.error) errors.ftps_reachable = ftpsReach.error;
  if (mqttRes.error) errors.mqtt = mqttRes.error;
  if (mqttRes.authOk && !mqttRes.reportReceived && !mqttRes.error) {
    errors.report_received = "connected but no report within timeout";
  }
  if (ftpsRes.error) errors.ftps = ftpsRes.error;

  return {
    host: opts.host,
    mqtt_reachable: mqttReach.ok,
    ftps_reachable: ftpsReach.ok,
    mqtt_auth_ok: mqttRes.authOk,
    report_received: mqttRes.reportReceived,
    ftps_auth_ok: ftpsRes.authOk,
    prot_mode: ftpsRes.protMode,
    prot_detail: ftpsRes.protDetail,
    sample_report: mqttRes.sample,
    errors,
  };
}

// ── raw TCP reachability ─────────────────────────────────────────────────────

function tcpReachable(
  host: string,
  port: number,
  timeoutMs: number,
): Promise<{ ok: boolean; error?: string }> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;
    const finish = (ok: boolean, error?: string) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(error ? { ok, error } : { ok });
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false, `timeout after ${timeoutMs}ms`));
    socket.once("error", (e) => finish(false, e.message));
    socket.connect(port, host);
  });
}

// ── MQTT auth + report ───────────────────────────────────────────────────────

interface MqttCheck {
  authOk: boolean;
  reportReceived: boolean;
  sample: Record<string, unknown> | null;
  error?: string;
}

function checkMqtt(cfg: Required<DiagnosticsOptions>): Promise<MqttCheck> {
  return new Promise((resolve) => {
    const url = `mqtts://${cfg.host}:${cfg.mqttPort}`;
    let settled = false;
    let authOk = false;
    let client: mqtt.MqttClient | null = null;

    const finish = (r: MqttCheck) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        client?.end(true);
      } catch {
        /* closing is best-effort */
      }
      resolve(r);
    };

    const timer = setTimeout(
      () => finish({ authOk, reportReceived: false, sample: null, error: `timeout after ${cfg.timeoutMs}ms` }),
      cfg.timeoutMs,
    );

    client = mqtt.connect(url, {
      username: cfg.username,
      password: cfg.accessCode,
      rejectUnauthorized: false, // spec 2: cert verification disabled
      reconnectPeriod: 0, // one shot — a diagnostic must not loop
      connectTimeout: cfg.timeoutMs,
    });

    client.on("connect", () => {
      authOk = true; // CONNACK accepted → credentials valid
      client!.subscribe(reportTopic(cfg.serial), (err) => {
        if (err) {
          finish({ authOk, reportReceived: false, sample: null, error: `subscribe: ${err.message}` });
          return;
        }
        client!.publish(requestTopic(cfg.serial), JSON.stringify({ pushing: { command: "pushall" } }));
      });
    });

    client.on("message", (_topic, payload) => {
      let msg: unknown;
      try {
        msg = JSON.parse(payload.toString());
      } catch {
        return;
      }
      const print = (msg as { print?: unknown }).print;
      // A push_status report (has gcode_state), not a command ack.
      if (print && typeof print === "object" && "gcode_state" in print) {
        finish({ authOk: true, reportReceived: true, sample: print as Record<string, unknown> });
      }
    });

    client.on("error", (e) => {
      // Auth rejection (bad access code) or connection error lands here.
      finish({ authOk, reportReceived: false, sample: null, error: e.message });
    });
  });
}

// ── FTPS auth + PROT probe ───────────────────────────────────────────────────

interface FtpsCheck {
  authOk: boolean;
  protMode: ProtMode;
  protDetail: string | null;
  error?: string;
}

async function checkFtps(cfg: Required<DiagnosticsOptions>): Promise<FtpsCheck> {
  // All printer FTPS I/O goes through the central session manager
  // (ftps-session.ts): serialized process-wide and always QUIT-terminated —
  // 実測 2026-07-02: QUIT releases the A1's single session slot immediately,
  // while an abrupt close blocks the next connection for 1-3 min.
  try {
    return await withFtpsSession(
      {
        host: cfg.host,
        port: cfg.ftpsPort,
        accessCode: cfg.accessCode,
        username: cfg.username,
        timeoutMs: cfg.timeoutMs,
      },
      async (client) => {
        // Logged in. Now probe which data-channel protection the server grants.
        const { mode, detail } = await probeProt(client);
        return { authOk: true as const, protMode: mode, protDetail: detail };
      },
    );
  } catch (e) {
    return {
      authOk: false,
      protMode: "none",
      protDetail: null,
      error: e instanceof FTPError ? e.message : (e as Error).message,
    };
  }
}

/**
 * Ask for PROT P; if the server refuses, fall back to PROT C — mirroring the A1
 * PROT C fallback (spec 20.6). `sendIgnoringError` returns the response for FTP
 * error codes instead of throwing, so we can read the code either way.
 */
async function probeProt(client: FtpClient): Promise<{ mode: ProtMode; detail: string }> {
  try {
    const p = await client.sendIgnoringError("PROT P");
    if (is2xx(p.code)) return { mode: "P", detail: `PROT P → ${p.code}` };
    const c = await client.sendIgnoringError("PROT C");
    const detail = `PROT P → ${p.code}; PROT C → ${c.code}`;
    return is2xx(c.code) ? { mode: "C", detail } : { mode: "none", detail };
  } catch (e) {
    return { mode: "none", detail: `PROT probe error: ${(e as Error).message}` };
  }
}

function is2xx(code: number): boolean {
  return code >= 200 && code < 300;
}
