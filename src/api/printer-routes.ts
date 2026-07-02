import { Hono } from "hono";
import type { Repo } from "../db/repo.ts";
import type { JobRow } from "../db/types.ts";

/**
 * Live printer status API (spec ch8/10 / spec 17 §7): `GET /api/printer/status`
 * exposes the latest MQTT-observed progress so the dashboard's printing header
 * can show a *measured* ETA (mc_remaining_time) instead of the static estimate.
 *
 * Thin adapter: the live values come from a status source (the orchestrator's
 * MQTT client, structurally); the current job comes from the Repo. No clock here
 * — the client turns remaining_min into a finish time in the browser's tz.
 */

/** The subset of the MQTT PrinterStatus this route needs (structural — the
 *  OrchestratorMqttClient's `latest()` satisfies it). */
export interface LiveStatus {
  gcodeState: string;
  mcPercent: number;
  mcRemainingTime: number; // minutes (mc_remaining_time)
}
export interface PrinterStatusSource {
  latest(): LiveStatus | null;
}

export interface PrinterStatusView {
  printing: boolean;
  job_id: number | null;
  percent: number;
  remaining_min: number;
  gcode_state: string;
}

/** gcode_states in which the printer is genuinely doing a print. IDLE / FINISH /
 *  FAILED / (unknown) are NOT active — a DB job stuck in 'printing' against any
 *  of those is a desync, not a live print. */
const ACTIVE_PRINT_STATES = new Set(["RUNNING", "PREPARE", "PAUSE", "SLICING"]);

/** Pure mapper: the currently-printing DB job + latest live status → the view
 *  sent over both HTTP (GET /api/printer/status) and SSE (event: progress).
 *
 *  `printing` follows the REAL printer (gcode_state), not just the DB: a job in
 *  DB 'printing' while the printer reports IDLE (a failed start / transient
 *  dispatch desync — 実測 2026-07-03) must NOT show as printing. The DB job
 *  supplies the id; the printer supplies whether it's actually running. */
export function printerStatusView(printing: JobRow | null, s: LiveStatus | null): PrinterStatusView {
  const gcodeState = s?.gcodeState ?? "IDLE";
  const active = !!printing && !!s && ACTIVE_PRINT_STATES.has(gcodeState);
  if (!active) {
    return { printing: false, job_id: printing?.id ?? null, percent: 0, remaining_min: 0, gcode_state: gcodeState };
  }
  return {
    printing: true,
    job_id: printing!.id,
    percent: Number.isFinite(s!.mcPercent) ? s!.mcPercent : 0,
    remaining_min: Number.isFinite(s!.mcRemainingTime) ? s!.mcRemainingTime : 0,
    gcode_state: gcodeState,
  };
}

export function createPrinterApp(deps: { repo: Repo; status: PrinterStatusSource }): Hono {
  const { repo, status } = deps;
  const app = new Hono();

  app.get("/api/printer/status", (c) =>
    c.json(printerStatusView(repo.listByStatus("printing")[0] ?? null, status.latest())),
  );

  return app;
}
