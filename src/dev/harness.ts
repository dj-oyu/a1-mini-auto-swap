import { mkdtempSync } from "node:fs";
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
import { createUiApp } from "../api/ui-routes.ts";
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
app.route("/", createWriteApp({ repo, dispatcher }));
app.route("/", createUploadApp({ repo, cacheDir }));
app.route("/", createThumbnailApp({ repo, cacheDir }));
app.route("/", createModelApp({ repo, cacheDir }));
// Fake live status so the dev printing header shows a measured ETA without a
// printer. Mutable so POST /__dev/progress can drive it (deterministic E2E).
let fake = { gcodeState: "RUNNING", mcPercent: 42, mcRemainingTime: 73 };
const fakeStatus: PrinterStatusSource = { latest: () => fake };
app.route("/", createPrinterApp({ repo, status: fakeStatus }));
app.route("/", createUiApp(repo));
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

// idleTimeout 0: keep long-lived SSE (/events) connections open (dev harness).
const server = Bun.serve({ port: HTTP_PORT, idleTimeout: 0, fetch: app.fetch });
console.log(`UI dev harness up (in-memory, seeded, NO real printer)`);
console.log(`  HTTP API  http://localhost:${server.port}`);
console.log(`  cache     ${cacheDir}`);
console.log(`  dashboard http://localhost:${server.port}/`);
console.log(`  try       curl http://localhost:${server.port}/api/queue`);
