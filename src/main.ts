import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Hono } from "hono";
import { openDb } from "./db/index.ts";
import { createApiApp } from "./api/routes.ts";
import { createWriteApp } from "./api/write-routes.ts";
import { createUploadApp } from "./api/upload-routes.ts";
import { createThumbnailApp } from "./api/thumbnail-routes.ts";
import { createModelApp } from "./api/model-routes.ts";
import { createPrinterApp } from "./api/printer-routes.ts";
import { createUiApp } from "./api/ui-routes.ts";
import { createEventsApp } from "./api/events-routes.ts";
import { SseBroadcaster } from "./orchestrator/sse-notifier.ts";
import { OrchestratorMqttClient } from "./orchestrator/mqtt-client.ts";
import { MqttFtpsPrinter, type ArtifactResolver } from "./orchestrator/mqtt-ftps-printer.ts";
import { PrintfarmGateway, MqttPublisherClient } from "./orchestrator/gateway.ts";
import { WebhookNotifier } from "./orchestrator/webhook-notifier.ts";
import { CompositeNotifier } from "./core/composite-notifier.ts";
import { createOrchestrator } from "./orchestrator/orchestrator.ts";
import { injectIntoThreemf } from "./injection/threemf.ts";
import type { Notifier } from "./core/ports.ts";

// Orchestrator entrypoint (spec 3): wires every adapter from env config into the
// running core loop, and serves the HTTP API. Thin — the assembly logic lives
// in createOrchestrator (integration-tested); this only builds the real adapters.

const env = (k: string, d?: string) => process.env[k] ?? d;
const num = (k: string, d: number) => Number(process.env[k] ?? d);

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
  const original = readFileSync(join(CACHE_DIR, `${job.id}.gcode.3mf`));
  const { bytes } = injectIntoThreemf(original, { endSnippet: SWAP_SNIPPET });
  return {
    bytes,
    remoteName: `${job.id}.gcode.3mf`,
    param: "Metadata/plate_1.gcode",
    url: `ftp:///cache/${job.id}.gcode.3mf`,
    amsMapping: JSON.parse(job.ams_mapping ?? "[-1,-1,-1,-1]") as number[],
  };
};
const printer = new MqttFtpsPrinter(
  mqtt,
  { host: PRINTER_HOST, port: PRINTER_FTPS_PORT, accessCode: PRINTER_ACCESS_CODE },
  resolver,
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
const orch = createOrchestrator({ repo, printer, notifier, gateway, status: mqtt });

const app = new Hono();
app.route("/", createApiApp(repo));
app.route("/", createWriteApp({ repo, dispatcher: orch.dispatcher }));
app.route("/", createUploadApp({ repo, cacheDir: CACHE_DIR })); // POST /api/queue → cache 3mf
app.route("/", createThumbnailApp({ repo, cacheDir: CACHE_DIR })); // GET …/thumbnail (spec 17 §6)
app.route("/", createModelApp({ repo, cacheDir: CACHE_DIR })); // GET …/model (spec 17 §9)
app.route("/", createPrinterApp({ repo, status: mqtt })); // GET /api/printer/status — live ETA (spec 10)
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
  orch.monitor.stop();
  await mqtt.close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
