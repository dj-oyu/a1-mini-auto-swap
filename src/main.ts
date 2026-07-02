import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Hono } from "hono";
import { openDb } from "./db/index.ts";
import { createApiApp } from "./api/routes.ts";
import { createWriteApp } from "./api/write-routes.ts";
import { createUploadApp } from "./api/upload-routes.ts";
import { createThumbnailApp } from "./api/thumbnail-routes.ts";
import { createModelApp } from "./api/model-routes.ts";
import { createPrinterApp, printerStatusView } from "./api/printer-routes.ts";
import { createSnapshotApp, type SnapshotSource } from "./api/snapshot-routes.ts";
import { createDiagnosticsApp } from "./api/diagnostics-routes.ts";
import { createUiApp } from "./api/ui-routes.ts";
import { createEventsApp } from "./api/events-routes.ts";
import { createAuth, createLoginApp } from "./api/auth.ts";
import { SseBroadcaster } from "./orchestrator/sse-notifier.ts";
import { OrchestratorMqttClient } from "./orchestrator/mqtt-client.ts";
import { MqttFtpsPrinter, type ArtifactResolver } from "./orchestrator/mqtt-ftps-printer.ts";
import { PrintfarmGateway, MqttPublisherClient } from "./orchestrator/gateway.ts";
import { WebhookNotifier } from "./orchestrator/webhook-notifier.ts";
import { CompositeNotifier } from "./core/composite-notifier.ts";
import { EscalationService } from "./core/escalation.ts";
import { createOrchestrator } from "./orchestrator/orchestrator.ts";
import { injectIntoThreemf } from "./injection/threemf.ts";
import { buildEjectThreemf } from "./injection/eject-threemf.ts";
import { systemClock, type Notifier } from "./core/ports.ts";
import { parseAmsMapping } from "./core/ams-mapping.ts";
import { cacheFileName, printArtifactName } from "./core/artifact.ts";

// Orchestrator entrypoint (spec 3): wires every adapter from env config into the
// running core loop, and serves the HTTP API. Thin — the assembly logic lives
// in createOrchestrator (integration-tested); this only builds the real adapters.

const env = (k: string, d?: string) => process.env[k] ?? d;
// Fail fast on malformed numeric env instead of booting with NaN ports/intervals.
const num = (k: string, d: number) => {
  const raw = process.env[k];
  if (raw === undefined || raw === "") return d;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`env ${k} must be a number, got "${raw}"`);
  return n;
};

const DB_PATH = env("DB_PATH", "./data/orchestrator.sqlite")!;
const CACHE_DIR = env("CACHE_DIR", "./data/cache")!;
const HTTP_PORT = num("HTTP_PORT", 3000);

const PRINTER_HOST = env("PRINTER_HOST", "127.0.0.1")!;
const PRINTER_MQTT_PORT = num("PRINTER_MQTT_PORT", 8883);
const PRINTER_FTPS_PORT = num("PRINTER_FTPS_PORT", 990);
const PRINTER_SERIAL = env("PRINTER_SERIAL", "STUB0001")!;
const PRINTER_ACCESS_CODE = env("PRINTER_ACCESS_CODE", "change-me")!;

const MOSQUITTO_URL = env("MOSQUITTO_URL", "mqtt://127.0.0.1:1883")!;
const DISCORD_WEBHOOK_URL = env("DISCORD_WEBHOOK_URL");
const BASE_URL = env("BASE_URL");

// The swap sequence baked into the print profile (spec 7). Placeholder default;
// TODO: load from the server-side profile (JSON, repo-managed).
const SWAP_SNIPPET = env("SWAP_SNIPPET", "G1 Z180 F3000\nM400")!;

// ── adapters ───────────────────────────────────────────────────────────────
const { db, repo } = openDb(DB_PATH);
void db;

const mqtt = new OrchestratorMqttClient({
  url: `mqtts://${PRINTER_HOST}:${PRINTER_MQTT_PORT}`,
  serial: PRINTER_SERIAL,
  accessCode: PRINTER_ACCESS_CODE,
});

/** Real artifact resolver (Phase 4c): read the uploaded 3mf from cache, inject
 *  the swap sequence + recompute the MD5 sidecar, return the upload bytes.
 *  (The POST /api/queue upload that populates the cache is a later slice.) */
const resolver: ArtifactResolver = (job) => {
  const original = readFileSync(join(CACHE_DIR, cacheFileName(job.id)));
  const { bytes } = injectIntoThreemf(original, { endSnippet: SWAP_SNIPPET });
  // remoteName/url use the job- prefixed printer-side name: the printer echoes
  // it as subtask_name, which the monitor correlates on (core/artifact.ts).
  return {
    bytes,
    remoteName: printArtifactName(job.id),
    param: "Metadata/plate_1.gcode",
    url: `ftp:///cache/${printArtifactName(job.id)}`,
    amsMapping: parseAmsMapping(job.ams_mapping), // validated, throws on corrupt data (INV-MQTT-01)
  };
};
const printer = new MqttFtpsPrinter(
  mqtt,
  { host: PRINTER_HOST, port: PRINTER_FTPS_PORT, accessCode: PRINTER_ACCESS_CODE },
  resolver,
  // spec 6/19 + INV-MQTT-02: after stop, send the dedicated eject job (homing +
  // the same swap sequence the profile bakes in) to return the mechanism to a
  // safe state. Bytes are deterministic for a given snippet.
  { ejectArtifact: () => buildEjectThreemf(SWAP_SNIPPET) },
);

const gateway = new PrintfarmGateway(new MqttPublisherClient(MOSQUITTO_URL));
const sse = new SseBroadcaster();
const notifiers: Notifier[] = [gateway, sse];
if (DISCORD_WEBHOOK_URL) {
  notifiers.push(new WebhookNotifier({ url: DISCORD_WEBHOOK_URL, baseUrl: BASE_URL }));
}
const notifier = new CompositeNotifier(notifiers);

// ── boot ───────────────────────────────────────────────────────────────────
await mqtt.connect();
const orch = createOrchestrator({
  repo,
  printer,
  notifier,
  gateway,
  status: mqtt,
  lowStockThreshold: num("STOCKER_LOW_THRESHOLD", 1),
});

// spec 13 escalation: re-notify unresolved blocking_queue pending actions every
// ESCALATION_INTERVAL_MIN until a human resolves them (INV-PENDING-03/05).
const escalation = new EscalationService(repo, notifier, systemClock, {
  intervalMs: num("ESCALATION_INTERVAL_MIN", 30) * 60_000,
});
const escalationTimer = setInterval(() => escalation.tick(), 60_000);

// Push live progress to browsers over SSE on every observed status update, so the
// printing header updates without polling (spec 10 / 17 §7).
mqtt.on("status", (s) => sse.sendProgress(printerStatusView(repo.listByStatus("printing")[0] ?? null, s)));

const app = new Hono();
// Opt-in fixed-token auth (spec 17). Installed before any route so it guards all
// of them; login + /vendor/* stay open. Off entirely when AUTH_TOKEN is unset.
const AUTH_TOKEN = env("AUTH_TOKEN");
if (AUTH_TOKEN) {
  app.use("*", createAuth(AUTH_TOKEN));
  app.route("/", createLoginApp(AUTH_TOKEN));
}
app.route("/", createApiApp(repo));
app.route("/", createWriteApp({ repo, dispatcher: orch.dispatcher }));
app.route("/", createUploadApp({ repo, cacheDir: CACHE_DIR })); // POST /api/queue → cache 3mf
app.route("/", createThumbnailApp({ repo, cacheDir: CACHE_DIR })); // GET …/thumbnail (spec 17 §6)
app.route("/", createModelApp({ repo, cacheDir: CACHE_DIR })); // GET …/model (spec 17 §9)
app.route("/", createPrinterApp({ repo, status: mqtt })); // GET /api/printer/status — live ETA (spec 10)
// TODO: capture the A1 mini camera (hardware-dependent/unverified). Until then
// latest() returns null → GET /api/printer/snapshot 404s (UI shows "なし").
const snapshotSource: SnapshotSource = { latest: () => null };
app.route("/", createSnapshotApp({ source: snapshotSource })); // GET /api/printer/snapshot (spec 17 §5)
app.route(
  "/",
  createDiagnosticsApp({
    // GET /api/diagnostics — connectivity probe against the configured printer
    // (spec 20.7). Same logic for stub or real A1 mini; eases Phase 8 cutover.
    target: {
      host: PRINTER_HOST,
      mqttPort: PRINTER_MQTT_PORT,
      ftpsPort: PRINTER_FTPS_PORT,
      serial: PRINTER_SERIAL,
      accessCode: PRINTER_ACCESS_CODE,
    },
  }),
);
app.route("/", createUiApp(repo)); // GET / → server-rendered dashboard (spec 17)
app.route("/", createEventsApp(sse)); // GET /events → SSE live updates (spec 17)

const server = Bun.serve({ port: HTTP_PORT, fetch: app.fetch });
console.log(`orchestrator up`);
console.log(`  printer   mqtts://${PRINTER_HOST}:${PRINTER_MQTT_PORT} (serial ${PRINTER_SERIAL})`);
console.log(`  gateway   ${MOSQUITTO_URL} → printfarm/*`);
console.log(`  webhook   ${DISCORD_WEBHOOK_URL ? "enabled" : "disabled"}`);
console.log(`  HTTP API  http://0.0.0.0:${server.port}`);

const shutdown = async () => {
  server.stop(true);
  clearInterval(escalationTimer);
  orch.monitor.stop();
  await mqtt.close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
