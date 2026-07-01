import { join } from "node:path";
import { VirtualPrinter } from "./virtual-printer.ts";
import { StubMqttServer } from "./mqtt-server.ts";
import { createControlApp, type DiagnosticsSnapshot } from "./control-api.ts";
import { Ticker } from "./ticker.ts";
import type { Tray } from "./types.ts";

// ── config (env-overridable, sensible defaults) ──────────────────────────────
const SERIAL = process.env.STUB_SERIAL ?? "STUB0001";
const MQTT_PORT = Number(process.env.STUB_MQTT_PORT ?? 8883);
const HTTP_PORT = Number(process.env.STUB_HTTP_PORT ?? 3001);
const SPEED_FACTOR = Number(process.env.STUB_SPEED_FACTOR ?? 1000);
const ACCESS_CODE = process.env.STUB_ACCESS_CODE ?? "stub-access-code";
const CERT_DIR = process.env.STUB_CERT_DIR ?? join(process.cwd(), "certs");

const INITIAL_TRAYS: Tray[] = [
  { index: 0, color: "#000000FF", type: "PLA", remaining_g: 1000 },
  { index: 1, color: "#FFFFFFFF", type: "PLA", remaining_g: 1000 },
  { index: 2, color: "#FF0000FF", type: "PLA", remaining_g: 1000 },
  { index: 3, color: "#0000FFFF", type: "PLA", remaining_g: 1000 },
];

// ── wiring ───────────────────────────────────────────────────────────────────
const printer = new VirtualPrinter(
  { serial: SERIAL, speedFactor: SPEED_FACTOR, fullSpoolGrams: 1000 },
  INITIAL_TRAYS,
);

const mqtt = new StubMqttServer(printer, { port: MQTT_PORT, certDir: CERT_DIR });
let mqttReachable = false;

const diagnostics = (): DiagnosticsSnapshot => ({
  mqtt_reachable: mqttReachable,
  ftps_reachable: false, // TODO Phase 2: implicit FTPS (990)
  developer_mode_enabled: true,
  access_code_valid: ACCESS_CODE.length > 0,
});

const app = createControlApp({ printer, diagnostics });

const ticker = new Ticker(printer);

// ── boot ──────────────────────────────────────────────────────────────────────
const boundMqttPort = await mqtt.listen(MQTT_PORT);
mqttReachable = true;
ticker.start();

const httpServer = Bun.serve({ port: HTTP_PORT, fetch: app.fetch });

console.log(`printer-stub up`);
console.log(`  serial       ${SERIAL}`);
console.log(`  MQTT (TLS)   mqtts://0.0.0.0:${boundMqttPort}`);
console.log(`  control/HTTP http://0.0.0.0:${httpServer.port}  (__control, /api/diagnostics)`);
console.log(`  speedFactor  ${SPEED_FACTOR}`);

const shutdown = async () => {
  console.log("\nshutting down printer-stub...");
  ticker.stop();
  httpServer.stop(true);
  await mqtt.close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
