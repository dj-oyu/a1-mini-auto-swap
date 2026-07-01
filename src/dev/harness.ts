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
import { createUiApp } from "../api/ui-routes.ts";
import { createEventsApp } from "../api/events-routes.ts";
import { SseBroadcaster } from "../orchestrator/sse-notifier.ts";
import { Dispatcher } from "../core/dispatcher.ts";
import type { PrinterPort } from "../core/ports.ts";
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

const { repo } = openDb(":memory:");
seedDevDb(repo);

const sse = new SseBroadcaster();
const dispatcher = new Dispatcher(repo, noopPrinter, { notifier: sse });
const cacheDir = mkdtempSync(join(tmpdir(), "a1-ui-dev-cache-"));

const app = new Hono();
app.route("/", createApiApp(repo));
app.route("/", createWriteApp({ repo, dispatcher }));
app.route("/", createUploadApp({ repo, cacheDir }));
app.route("/", createThumbnailApp({ repo, cacheDir }));
app.route("/", createModelApp({ repo, cacheDir }));
app.route("/", createUiApp(repo));
app.route("/", createEventsApp(sse));

const server = Bun.serve({ port: HTTP_PORT, fetch: app.fetch });
console.log(`UI dev harness up (in-memory, seeded, NO real printer)`);
console.log(`  HTTP API  http://localhost:${server.port}`);
console.log(`  cache     ${cacheDir}`);
console.log(`  dashboard http://localhost:${server.port}/`);
console.log(`  try       curl http://localhost:${server.port}/api/queue`);
