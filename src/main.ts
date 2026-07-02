import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
import { createCameraApp } from "./api/camera-routes.ts";
import { CameraRelay, relaySnapshotSource } from "./orchestrator/camera-relay.ts";
import { createDiagnosticsApp } from "./api/diagnostics-routes.ts";
import { createUiApp } from "./api/ui-routes.ts";
import { createVerifyApp } from "./api/verify-routes.ts";
import { createEventsApp } from "./api/events-routes.ts";
import { runDiagnostics, type DiagnosticsOptions } from "./orchestrator/diagnostics.ts";
import { uploadBytes } from "./orchestrator/ftps-client.ts";
import { A1_MINI_SAFE_BOUNDS, buildDryRehearsalGcode } from "./core/dry-gcode.ts";
import { packageGcodeThreemf } from "./injection/gcode-threemf.ts";
import { findUnsafeLines } from "../scripts/dry-rehearsal-3mf.ts";
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
import { cacheFileName, printArtifactName, printerUploadPath } from "./core/artifact.ts";
import { throttleUploadProgress } from "./orchestrator/upload-progress-throttle.ts";

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

// No default: without a Mosquitto broker configured (e.g. Windows dev boxes
// running against printer-stub only), the printfarm/* gateway is disabled
// entirely rather than repeatedly failing to connect to 127.0.0.1:1883.
const MOSQUITTO_URL = env("MOSQUITTO_URL");
const DISCORD_WEBHOOK_URL = env("DISCORD_WEBHOOK_URL");
const BASE_URL = env("BASE_URL");

// The swap sequence baked into the print profile (spec 7): the real Niiさん mod
// sequence lives in the repo-managed profile file so it flows automatically into
// both the print pipeline (resolver → injectIntoThreemf → injectEndSequence,
// MD5 recomputed) and the eject job (buildEjectThreemf) below — there is no
// separate wiring for either. `SWAP_SNIPPET` env stays as an override escape
// hatch (e.g. Stage 7's real-print note: swap it out for a harmless snippet
// while validating the rest of the pipeline). Comment lines in the profile are
// preserved verbatim (gcode-inject.ts only trims leading/trailing whitespace).
const SWAP_PROFILE_PATH = "profiles/swap-sequence.gcode";
const swapSnippetOverride = env("SWAP_SNIPPET");
const SWAP_SNIPPET = swapSnippetOverride ?? readFileSync(SWAP_PROFILE_PATH, "utf8");
const swapProfileLabel = swapSnippetOverride
  ? "swap profile: (env override)"
  : `swap profile: ${SWAP_PROFILE_PATH} (${SWAP_SNIPPET.trim().split("\n").length} lines)`;

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
  // `param` is the ACTUAL plate gcode path inside the archive — a single-plate
  // export from a multi-plate project keeps its original number (plate_24, not
  // plate_1), so it's discovered, never hardcoded (実測 2026-07-02).
  const { bytes, param } = injectIntoThreemf(original, { endSnippet: SWAP_SNIPPET });
  // remoteName/url use the job- prefixed printer-side name: the printer echoes
  // it as subtask_name, which the monitor correlates on (core/artifact.ts).
  return {
    bytes,
    remoteName: printArtifactName(job.id),
    param,
    url: `ftp:///cache/${printArtifactName(job.id)}`,
    amsMapping: parseAmsMapping(job.ams_mapping), // validated, throws on corrupt data (INV-MQTT-01)
  };
};
const printerFtps = { host: PRINTER_HOST, port: PRINTER_FTPS_PORT, accessCode: PRINTER_ACCESS_CODE };
// Upload-progress indicator (SSE-only, never through Notifier — see
// sse-notifier.ts). Created before `printer` so its onUploadProgress can push
// straight to the broadcaster.
const sse = new SseBroadcaster();
const printer = new MqttFtpsPrinter(
  mqtt,
  printerFtps,
  resolver,
  {
    // spec 6/19 + INV-MQTT-02: after stop, send the dedicated eject job (homing +
    // the same swap sequence the profile bakes in) to return the mechanism to a
    // safe state. Bytes are deterministic for a given snippet.
    ejectArtifact: () => buildEjectThreemf(SWAP_SNIPPET),
    // Already throttled inside MqttFtpsPrinter — forward straight to SSE.
    onUploadProgress: (context, p) => sse.sendUploadProgress({ context, ...p }),
  },
);

// printfarm/* gateway is opt-in: only built when MOSQUITTO_URL is set, so
// dev/test runs without a local Mosquitto broker don't attempt (and spam-log)
// a connection to a broker that isn't there.
const gateway = MOSQUITTO_URL ? new PrintfarmGateway(new MqttPublisherClient(MOSQUITTO_URL)) : undefined;
const notifiers: Notifier[] = [sse];
if (gateway) notifiers.push(gateway);
if (DISCORD_WEBHOOK_URL) {
  notifiers.push(new WebhookNotifier({ url: DISCORD_WEBHOOK_URL, baseUrl: BASE_URL }));
}
const notifier = new CompositeNotifier(notifiers);

// Connectivity-probe target, shared by GET /api/diagnostics and the /verify
// wizard's Stage 1-3 (spec 20.7). Built from the configured printer; the access
// code is used only as a credential and never surfaced in results.
const diagTarget: DiagnosticsOptions = {
  host: PRINTER_HOST,
  mqttPort: PRINTER_MQTT_PORT,
  ftpsPort: PRINTER_FTPS_PORT,
  serial: PRINTER_SERIAL,
  accessCode: PRINTER_ACCESS_CODE,
};

// Stage 5 dry-rehearsal: build the print-free motion test with the shared A1
// safe bounds, run the last-line-of-defense heater/extrusion guard, package it,
// FTPS-upload it and start it via MQTT. The remote name sits OUTSIDE the `job-`
// prefix so the monitor never mis-attributes it to a DB job (core/artifact.ts).
//
// `includeSwap` (spec 20.7 Stage 5 "スワップ込みリハーサル"): when set, the real
// swap profile is appended after the motion trajectory (dry-gcode.ts §9), so
// the rehearsal also exercises a real plate swap. findUnsafeLines still runs
// over the WHOLE program including the swap block — the profile has no heater/
// extrusion commands, so it passes — but the guard is never bypassed for it.
const DRY_REHEARSAL_ARTIFACT = "dry-rehearsal.gcode.3mf";
async function startDryRun(includeSwap: boolean): Promise<void> {
  const gcode = buildDryRehearsalGcode(A1_MINI_SAFE_BOUNDS, {
    sweepDurationMs: 5000,
    feedrate: 3000,
    danceAmplitudeMm: 30,
    ...(includeSwap ? { swapSequence: SWAP_SNIPPET } : {}),
  });
  const unsafe = findUnsafeLines(gcode);
  if (unsafe.length > 0) {
    // Never publish a rehearsal that could heat or extrude (INV-DRY-01/02).
    throw new Error(`refusing dry-rehearsal: ${unsafe.length} unsafe line(s) (heater/E-axis, INV-DRY-01/02)`);
  }
  const bytes = packageGcodeThreemf(gcode);
  // Upload-progress indicator (Stage 5 live bar, verify.js): a fresh throttle
  // per call, matching this one transfer's lifetime.
  const onProgress = throttleUploadProgress(
    (p) => sse.sendUploadProgress({ context: "dry-rehearsal", ...p }),
    systemClock,
  );
  await uploadBytes({ ...printerFtps, onProgress }, bytes, printerUploadPath(DRY_REHEARSAL_ARTIFACT));
  mqtt.publishProjectFile({
    param: "Metadata/plate_1.gcode",
    url: `ftp:///cache/${DRY_REHEARSAL_ARTIFACT}`,
    amsMapping: [-1, -1, -1, -1], // motion only — no filament use
    useAms: false,
    sequenceId: "dry-rehearsal",
    subtaskName: DRY_REHEARSAL_ARTIFACT,
    // motion test: no calibration (bed_leveling etc. default false)
  });
}

// ── boot ───────────────────────────────────────────────────────────────────
// Initialize the stocker on first boot: a fresh DB has no stocker_state row, so
// the dispatcher would report "stocker_empty" and never print. capacity is a
// hardware-fixed value (spec 11, Swap Systems 参考値 10); adjust later via
// POST /api/stocker or the stocker chip. Existing rows are left untouched.
const STOCKER_CAPACITY = num("STOCKER_CAPACITY", 10);
if (!repo.getStocker()) {
  repo.setStocker(STOCKER_CAPACITY, STOCKER_CAPACITY);
  console.log(`  stocker   initialized: ${STOCKER_CAPACITY}/${STOCKER_CAPACITY} (STOCKER_CAPACITY)`);
}

await mqtt.connect();
const orch = createOrchestrator({
  repo,
  printer,
  notifier,
  gateway,
  status: mqtt,
  lowStockThreshold: num("STOCKER_LOW_THRESHOLD", 1),
});

// Reconcile stale state on boot: if the DB thinks a job is 'printing' but the
// real printer isn't (crash mid-print, or a failed start that stranded the job
// — 実測 2026-07-03), revert it to 'queued' so the UI stops lying. Wait for the
// first real report before judging (mqtt.latest() is null until then).
const printingAtBoot = repo.listByStatus("printing");
if (printingAtBoot.length > 0) {
  const s = await mqtt.waitForStatus(() => true, 8_000);
  const reallyPrinting = s?.gcodeState === "RUNNING" || s?.gcodeState === "PREPARE";
  if (!reallyPrinting) {
    for (const j of printingAtBoot) repo.updateStatus(j.id, "queued");
    console.log(`  reconcile: ${printingAtBoot.length} stale 'printing' → queued (printer ${s?.gcodeState ?? "unknown"})`);
  }
}

// Resume any job left 'queued' by a previous run (crash/restart recovery):
// dispatchNext no-ops on an idle-with-empty-queue boot, and reverts to queued
// if the start fails, so this is safe to fire unconditionally.
void orch.dispatcher.dispatchNext().catch((e) => console.warn(`[boot] dispatch: ${(e as Error).message}`));

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
// Real A1 chamber camera (port-6000 protocol, 実測 2026-07-02): ONE shared
// upstream relay feeds both the live MJPEG stream and one-off snapshots, so any
// number of browser tabs never opens more than one camera connection. A dead
// camera degrades to 404 (snapshot) / a stalled stream (MJPEG) — never throws.
const cameraRelay = new CameraRelay({
  host: PRINTER_HOST,
  accessCode: PRINTER_ACCESS_CODE,
  port: num("PRINTER_CAMERA_PORT", 6000),
});
const snapshotSource: SnapshotSource = relaySnapshotSource(cameraRelay);
app.route("/", createSnapshotApp({ source: snapshotSource })); // GET /api/printer/snapshot (spec 17 §5)
app.route("/", createCameraApp({ relay: cameraRelay })); // GET /api/printer/camera.mjpeg — live relay
app.route(
  "/",
  createDiagnosticsApp({
    // GET /api/diagnostics — connectivity probe against the configured printer
    // (spec 20.7). Same logic for stub or real A1 mini; eases Phase 8 cutover.
    target: diagTarget,
  }),
);
app.route("/", createUiApp(repo)); // GET / → server-rendered dashboard (spec 17)
// ── TEMPORARY (実機検証用 — 確認後に削除, task#16): swap直前スナップ+Discord ──
// Field test of the pre-swap snapshot pipeline: camera relay frame → save →
// Discord photo attachment. Auto trigger: while armed, fire ONCE when a
// RUNNING report reaches layer_num >= total_layer_num (>0) — i.e. the print
// body is done and the appended swap sequence is next — or, for artifacts
// without slice metadata (dry-rehearsal 3mf reports 0/0), on the RUNNING→
// FINISH edge as a fallback (captures right after the swap instead).
const tempPhotoWebhook = DISCORD_WEBHOOK_URL
  ? new WebhookNotifier({ url: DISCORD_WEBHOOK_URL, baseUrl: BASE_URL })
  : undefined;
const tempAutoState: { armed: boolean; fired: { trigger: string; at: string; photoSent: boolean } | null } = {
  armed: false,
  fired: null,
};
const tempSendPhotoReport = async (jpeg: Buffer, note: string): Promise<boolean> => {
  if (!tempPhotoWebhook) return false;
  try {
    await tempPhotoWebhook.sendWithPhoto({ type: "job_finished", message: note }, jpeg, "preswap.jpg");
    return true;
  } catch (e) {
    console.warn(`[temp-photo] Discord送信失敗: ${(e as Error).message}`);
    return false;
  }
};
const tempFire = async (trigger: string): Promise<void> => {
  tempAutoState.armed = false; // fire once per arm
  const jpeg = await cameraRelay.snapshot(10_000);
  const photoSent = jpeg
    ? await tempSendPhotoReport(jpeg, `実機検証テスト: swap直前スナップ (trigger=${trigger})`)
    : false;
  tempAutoState.fired = { trigger, at: new Date().toISOString(), photoSent };
  if (jpeg) {
    mkdirSync("./data/snapshots", { recursive: true });
    writeFileSync(`./data/snapshots/preswap-test-${Date.now()}.jpg`, jpeg);
  }
  console.log(`[temp-photo] fired trigger=${trigger} frame=${jpeg ? jpeg.length + "B" : "none"} discord=${photoSent}`);
};
let tempPrevState = "";
let tempLayerFired = false;
mqtt.on("status", (s) => {
  // TEMPORARY listener (task#16)
  if (tempAutoState.armed) {
    if (s.gcodeState === "RUNNING" && s.totalLayerNum > 0 && s.layerNum >= s.totalLayerNum && !tempLayerFired) {
      tempLayerFired = true;
      void tempFire("layer==total (swap直前)");
    } else if (tempPrevState === "RUNNING" && s.gcodeState === "FINISH") {
      void tempFire("FINISHエッジ (フォールバック)");
    }
  }
  if (s.gcodeState !== "RUNNING") tempLayerFired = false;
  tempPrevState = s.gcodeState;
});

app.route(
  "/",
  createVerifyApp({
    // GET /verify — the Stage 1-7 real-hardware verification wizard. Every real
    // I/O is injected here; the routes hold no domain logic.
    repo,
    runDiagnostics: () => runDiagnostics(diagTarget),
    printerStatus: () => printerStatusView(repo.listByStatus("printing")[0] ?? null, mqtt.latest()),
    startDryRun,
    eject: () => printer.ejectAndReset(),
    hasPrintingJob: () => repo.listByStatus("printing").length > 0,
    // TEMPORARY (task#16):
    testSnapshot: () => cameraRelay.snapshot(10_000),
    sendPhotoReport: tempSendPhotoReport,
    armAutoCapture: (armed) => {
      tempAutoState.armed = armed;
      if (armed) tempAutoState.fired = null;
    },
    autoCaptureState: () => ({ ...tempAutoState }),
  }),
);
app.route("/", createEventsApp(sse)); // GET /events → SSE live updates (spec 17)

// idleTimeout 0: Bun's 10s default kills (a) SSE /events streams and (b) slow
// responses like the verify dry-run, whose FTPS upload may retry for 60s+
// while the printer releases its session slot (実測 2026-07-02 — the request
// died at 10s while the upload retry was still working, so the UI showed an
// error although the print then started). The dev harness already runs with
// idleTimeout: 0 for the same reason.
const server = Bun.serve({ port: HTTP_PORT, idleTimeout: 0, fetch: app.fetch });
console.log(`orchestrator up`);
console.log(`  ${swapProfileLabel}`);
console.log(`  printer   mqtts://${PRINTER_HOST}:${PRINTER_MQTT_PORT} (serial ${PRINTER_SERIAL})`);
console.log(gateway ? `  gateway   ${MOSQUITTO_URL} → printfarm/*` : `  gateway   disabled (MOSQUITTO_URL unset)`);
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
