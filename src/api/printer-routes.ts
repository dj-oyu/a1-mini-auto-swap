import { Hono } from "hono";
import type { Repo } from "../db/repo.ts";

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

export function createPrinterApp(deps: { repo: Repo; status: PrinterStatusSource }): Hono {
  const { repo, status } = deps;
  const app = new Hono();

  app.get("/api/printer/status", (c) => {
    const printing = repo.listByStatus("printing")[0] ?? null;
    const s = status.latest();
    if (!printing || !s) {
      return c.json<PrinterStatusView>({
        printing: false,
        job_id: null,
        percent: 0,
        remaining_min: 0,
        gcode_state: s?.gcodeState ?? "IDLE",
      });
    }
    return c.json<PrinterStatusView>({
      printing: true,
      job_id: printing.id,
      percent: Number.isFinite(s.mcPercent) ? s.mcPercent : 0,
      remaining_min: Number.isFinite(s.mcRemainingTime) ? s.mcRemainingTime : 0,
      gcode_state: s.gcodeState,
    });
  });

  return app;
}
