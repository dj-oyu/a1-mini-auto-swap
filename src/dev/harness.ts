import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { openDb } from "../db/index.ts";
import { createApiApp } from "../api/routes.ts";
import { createWriteApp } from "../api/write-routes.ts";
import { createUploadApp } from "../api/upload-routes.ts";
import { createThumbnailApp } from "../api/thumbnail-routes.ts";
import { createModelApp } from "../api/model-routes.ts";
import { createPrinterApp, printerStatusView, type PrinterStatusSource } from "../api/printer-routes.ts";
import { createSnapshotApp } from "../api/snapshot-routes.ts";
import { createCameraApp } from "../api/camera-routes.ts";
import { relaySnapshotSource, type FrameRelay } from "../orchestrator/camera-relay.ts";
import { createUiApp } from "../api/ui-routes.ts";
import { createLogsApp } from "../api/logs-routes.ts";
import { createVerifyApp } from "../api/verify-routes.ts";
import { createEventsApp } from "../api/events-routes.ts";
import { createAuth, createLoginApp } from "../api/auth.ts";
import { SseBroadcaster } from "../orchestrator/sse-notifier.ts";
import { Dispatcher } from "../core/dispatcher.ts";
import type { NotifyEvent, PrinterPort } from "../core/ports.ts";
import { seedDevDb } from "./seed.ts";

// Dev harness (docs/ui-handoff.md §2): serve the full HTTP API over an in-memory
// SQLite DB seeded with a realistic dataset, so the Web UI can be developed with
// no printer/broker/hardware. This is a composition root — like src/main.ts it
// wires adapters and is not unit-tested; the seed contract is covered by
// test/dev/seed.test.ts. NOT for production (no persistence, no real printer).

const num = (k: string, d: number) => Number(process.env[k] ?? d);
const HTTP_PORT = num("HTTP_PORT", 3000);

// A printer that does nothing: the write routes only ever call dispatcher.retry
// (which re-queues without touching the printer). Any accidental dispatch here
// must not reach hardware, so every method is an inert no-op.
const noopPrinter: PrinterPort = {
  async startPrint() {},
  async ejectAndReset() {},
  async resumeWithAlternateSlot() {},
};

const { db, repo } = openDb(":memory:");
// SEED=0 boots an empty DB (used by the empty-state E2E); default seeds the demo.
if (process.env.SEED !== "0") seedDevDb(repo);

/** Wipe all rows + reset AUTOINCREMENT counters, then optionally re-seed. Used
 *  by the E2E suite (POST /__dev/reset[?seed=0]) to get deterministic, isolated
 *  state per test. Dev harness only — never mounted by src/main.ts. */
function resetDb(seed: boolean): void {
  db.run("PRAGMA foreign_keys = OFF");
  for (const t of ["pending_actions", "jobs", "projects", "stocker_state", "system_settings"]) {
    db.run(`DELETE FROM ${t}`);
  }
  db.run("DELETE FROM sqlite_sequence"); // restart AUTOINCREMENT ids at 1
  db.run("PRAGMA foreign_keys = ON");
  if (seed) seedDevDb(repo);
}

const sse = new SseBroadcaster();
const dispatcher = new Dispatcher(repo, noopPrinter, { notifier: sse });
const cacheDir = mkdtempSync(join(tmpdir(), "a1-ui-dev-cache-"));

const app = new Hono();
// Opt-in auth for manual dev testing (off by default; E2E runs without it).
if (process.env.AUTH_TOKEN) {
  app.use("*", createAuth(process.env.AUTH_TOKEN));
  app.route("/", createLoginApp(process.env.AUTH_TOKEN));
}
app.route("/", createApiApp(repo));
app.route("/", createWriteApp({ repo, dispatcher, cacheDir }));
app.route("/", createUploadApp({ repo, cacheDir }));
app.route("/", createThumbnailApp({ repo, cacheDir }));
app.route("/", createModelApp({ repo, cacheDir }));
// Fake live status so the dev printing header shows a measured ETA without a
// printer. Mutable so POST /__dev/progress can drive it (deterministic E2E).
let fake = { gcodeState: "RUNNING", mcPercent: 42, mcRemainingTime: 73 };
const fakeStatus: PrinterStatusSource = { latest: () => fake };
app.route("/", createPrinterApp({ repo, status: fakeStatus }));
// Fake camera relay: a real (committed) JPEG re-sent every second, so both the
// live MJPEG stream (/api/printer/camera.mjpeg) and one-off snapshots work with
// no printer. Mirrors CameraRelay's contract (latest cached, fan-out on subscribe)
// but with a fixed frame — no upstream socket, dev-only churn is irrelevant.
const PLACEHOLDER_JPEG = readFileSync(join(import.meta.dir, "placeholder-camera.jpg"));
class DevCameraRelay implements FrameRelay {
  private readonly listeners = new Set<(jpeg: Buffer) => void>();
  private timer: ReturnType<typeof setInterval> | null = null;
  latest(): Buffer {
    return PLACEHOLDER_JPEG;
  }
  async snapshot(): Promise<Buffer> {
    return PLACEHOLDER_JPEG;
  }
  subscribe(onFrame: (jpeg: Buffer) => void): () => void {
    this.listeners.add(onFrame);
    queueMicrotask(() => {
      if (this.listeners.has(onFrame)) onFrame(PLACEHOLDER_JPEG); // immediate first frame
    });
    if (!this.timer) {
      this.timer = setInterval(() => {
        for (const l of [...this.listeners]) l(PLACEHOLDER_JPEG);
      }, 1000);
      this.timer.unref?.();
    }
    return () => {
      this.listeners.delete(onFrame);
      if (this.listeners.size === 0 && this.timer) {
        clearInterval(this.timer);
        this.timer = null;
      }
    };
  }
}
const cameraRelay = new DevCameraRelay();
app.route("/", createSnapshotApp({ source: relaySnapshotSource(cameraRelay) }));
app.route("/", createCameraApp({ relay: cameraRelay }));
app.route("/", createUiApp({ repo, cacheDir }));
// Log viewer (task #24): the in-memory harness writes no audit files itself, but
// mounting the route lets the UI be developed against ./data/logs if a real
// orchestrator run has populated it (else the viewer just shows「ログがありません」).
app.route(
  "/",
  createLogsApp({
    logDir: process.env.LOG_DIR ?? "./data/logs",
    mqttLogDir: process.env.MQTT_LOG_DIR ?? "./data/mqtt-log",
    mqttLogEnabled: process.env.MQTT_LOG === "1",
  }),
);
// 実機検証ガイド (/verify): fake deps that succeed immediately, so the whole page
// works with no printer/broker. runDiagnostics reports an all-green probe with a
// PROT C fallback (the A1's ★ unverified case); printerStatus is IDLE so the
// dry-run guard allows a run and Stage 4 passes; startDryRun/eject are no-ops.
app.route(
  "/",
  createVerifyApp({
    repo,
    runDiagnostics: async () => ({
      host: "printer-stub",
      mqtt_reachable: true,
      ftps_reachable: true,
      mqtt_auth_ok: true,
      report_received: true,
      ftps_auth_ok: true,
      prot_mode: "C",
      prot_detail: "PROT P → 522; PROT C → 200",
      sample_report: { gcode_state: "IDLE", mc_percent: 0, mc_remaining_time: 0, subtask_name: "" },
      errors: {},
    }),
    printerStatus: () => ({ printing: false, job_id: null, percent: 0, remaining_min: 0, gcode_state: "IDLE" }),
    startDryRun: async (_includeSwap: boolean) => {},
    eject: async () => {},
  }),
);
app.route("/", createEventsApp(sse));

// Dev-only test hook: reset in-memory state between E2E tests.
app.post("/__dev/reset", (c) => {
  resetDb(c.req.query("seed") !== "0");
  return c.json({ ok: true });
});

// Dev-only test hook: emit a notification over SSE (e.g. stocker_low toast).
app.post("/__dev/notify", (c) => {
  const type = (c.req.query("type") ?? "stocker_low") as NotifyEvent["type"];
  const message = c.req.query("message") ?? "最後のビルドプレートをベッドに載せました。補充してください";
  sse.notify({ type, severity: "advisory", message });
  return c.json({ ok: true });
});

// Dev-only test hook: drive the fake live status + push a progress SSE frame
// (deterministic E2E for the push-based ETA — no timers).
app.post("/__dev/progress", (c) => {
  const q = c.req.query();
  fake = {
    gcodeState: q.gcode_state ?? "RUNNING",
    mcPercent: Number(q.percent ?? fake.mcPercent),
    mcRemainingTime: Number(q.remaining_min ?? fake.mcRemainingTime),
  };
  const printing = repo.listByStatus("printing")[0] ?? null;
  sse.sendProgress(printerStatusView(printing, fake));
  return c.json({ ok: true });
});

// Dev-only test hook: push an upload-progress SSE frame directly (deterministic
// E2E for the FTPS upload indicator — no real transfer, no timers). Mirrors
// __dev/progress: query params in, one sendUploadProgress() out.
app.post("/__dev/upload-progress", (c) => {
  const q = c.req.query();
  sse.sendUploadProgress({
    context: q.context ?? "dry-rehearsal",
    bytesSent: Number(q.bytes_sent ?? 0),
    totalBytes: Number(q.total_bytes ?? 100),
  });
  return c.json({ ok: true });
});

// idleTimeout 0: keep long-lived SSE (/events) connections open (dev harness).
const server = Bun.serve({ port: HTTP_PORT, idleTimeout: 0, fetch: app.fetch });
console.log(`UI dev harness up (in-memory, seeded, NO real printer)`);
console.log(`  HTTP API  http://localhost:${server.port}`);
console.log(`  cache     ${cacheDir}`);
console.log(`  dashboard http://localhost:${server.port}/`);
console.log(`  try       curl http://localhost:${server.port}/api/queue`);
