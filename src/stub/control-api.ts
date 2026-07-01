import { Hono } from "hono";
import { VirtualPrinter } from "./virtual-printer.ts";
import type { FaultCategory, FaultTiming } from "./types.ts";

export interface DiagnosticsSnapshot {
  mqtt_reachable: boolean;
  ftps_reachable: boolean;
  developer_mode_enabled: boolean;
  access_code_valid: boolean;
}

export interface ControlAppDeps {
  printer: VirtualPrinter;
  /** spec 20.7 diagnostics; computed by main() from live server state */
  diagnostics: () => DiagnosticsSnapshot;
}

/**
 * The stub's HTTP surface: the `__control` test backdoor (spec 20.4/20.5) and
 * the `/api/diagnostics` endpoint (spec 20.7) that works identically against
 * stub and real hardware. Returned as a Hono app so it can be unit-tested via
 * `app.request(...)` with no server/port — and served in one process by main().
 */
export function createControlApp(deps: ControlAppDeps): Hono {
  const { printer, diagnostics } = deps;
  const app = new Hono();

  // ── __control backdoor ────────────────────────────────────────────────────
  app.post("/__control/ams/:slot", async (c) => {
    const slot = Number(c.req.param("slot"));
    if (!Number.isInteger(slot) || slot < 0) return c.json({ error: "bad slot" }, 400);
    const body = (await c.req.json().catch(() => ({}))) as {
      remaining_g?: number;
      color?: string;
      type?: string;
    };
    printer.setAms(slot, body);
    return c.json({ ok: true, slot });
  });

  app.post("/__control/fault", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      category?: FaultCategory;
      timing?: FaultTiming;
    };
    if (!body.category || !body.timing) return c.json({ error: "category and timing required" }, 400);
    printer.injectFault({ category: body.category, timing: body.timing });
    return c.json({ ok: true });
  });

  app.post("/__control/finish", (c) => {
    printer.forceFinish();
    return c.json({ ok: true, state: printer.state });
  });

  app.post("/__control/fail", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { code?: number };
    printer.forceFail(body.code);
    return c.json({ ok: true, state: printer.state });
  });

  app.post("/__control/speed", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { factor?: number };
    if (!body.factor || body.factor <= 0) return c.json({ error: "factor > 0 required" }, 400);
    printer.setSpeedFactor(body.factor);
    return c.json({ ok: true, factor: body.factor });
  });

  app.post("/__control/print_minutes", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { minutes?: number };
    if (!body.minutes || body.minutes <= 0) return c.json({ error: "minutes > 0 required" }, 400);
    printer.setPrintMinutes(body.minutes);
    return c.json({ ok: true });
  });

  app.post("/__control/reset", (c) => {
    printer.reset();
    return c.json({ ok: true, state: printer.state });
  });

  // Inspection: current true state (buildReport always reflects reality).
  app.get("/__control/state", (c) => c.json(printer.buildReport()));

  // ── diagnostics (spec 20.7) — same shape for stub and real printer ─────────
  app.get("/api/diagnostics", (c) => c.json(diagnostics()));

  // ── snapshot (spec 20.2) — fixed 1x1 PNG placeholder ───────────────────────
  app.get("/api/printer/snapshot", (c) => {
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
      "base64",
    );
    return c.body(png, 200, { "Content-Type": "image/png" });
  });

  return app;
}
