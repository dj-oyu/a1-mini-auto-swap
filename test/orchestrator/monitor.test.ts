import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VirtualPrinter } from "../../src/stub/virtual-printer.ts";
import { StubMqttServer } from "../../src/stub/mqtt-server.ts";
import { StubFtpsServer } from "../../src/stub/ftps-server.ts";
import { openDb, type Db } from "../../src/db/index.ts";
import { Dispatcher } from "../../src/core/dispatcher.ts";
import { OrchestratorMqttClient } from "../../src/orchestrator/mqtt-client.ts";
import { MqttFtpsPrinter, type ArtifactResolver } from "../../src/orchestrator/mqtt-ftps-printer.ts";
import { Monitor } from "../../src/orchestrator/monitor.ts";

const SERIAL = "STUB0004";
const ACCESS = "stub-access-code";
const CERT_DIR = join(process.cwd(), "certs");

let printer: VirtualPrinter;
let mqttServer: StubMqttServer;
let ftpsServer: StubFtpsServer;
let client: OrchestratorMqttClient;
let dbh: Db;
let dispatcher: Dispatcher;
let monitor: Monitor;
let uploadDir: string;

const resolver: ArtifactResolver = (job) => ({
  bytes: Buffer.from(`3mf ${job.id}`),
  remoteName: `job-${job.id}.gcode.3mf`,
  param: "Metadata/plate_1.gcode",
  url: `ftp:///cache/job-${job.id}.gcode.3mf`,
  amsMapping: [-1, -1, 0, -1],
});

beforeAll(async () => {
  uploadDir = mkdtempSync(join(tmpdir(), "monitor-"));
  printer = new VirtualPrinter({ serial: SERIAL, speedFactor: 60000, fullSpoolGrams: 1000 }, [
    { index: 2, color: "#FF0000FF", type: "PLA", remaining_g: 5000 },
  ]);
  mqttServer = new StubMqttServer(printer, { port: 0, certDir: CERT_DIR });
  ftpsServer = new StubFtpsServer({ certDir: CERT_DIR, accessCode: ACCESS, uploadDir });
  const mqttPort = await mqttServer.listen(0);
  const ftpsPort = await ftpsServer.listen(0);

  client = new OrchestratorMqttClient({ url: `mqtts://127.0.0.1:${mqttPort}`, serial: SERIAL, accessCode: ACCESS });
  await client.connect();

  dbh = openDb(":memory:");
  dbh.repo.setStocker(10, 10);
  const port = new MqttFtpsPrinter(client, { host: "127.0.0.1", port: ftpsPort, accessCode: ACCESS }, resolver);
  dispatcher = new Dispatcher(dbh.repo, port);
  monitor = new Monitor(client, dbh.repo, dispatcher);
  monitor.start();
});

afterAll(async () => {
  monitor.stop();
  await client.close();
  await mqttServer.close();
  await ftpsServer.close();
  dbh.close();
  rmSync(uploadDir, { recursive: true, force: true });
});

function waitFor(cond: () => boolean, ms = 4000): Promise<void> {
  return new Promise((resolve, reject) => {
    if (cond()) return resolve();
    const t = setInterval(() => {
      if (cond()) {
        clearInterval(t);
        resolve();
      }
    }, 15);
    setTimeout(() => {
      clearInterval(t);
      reject(new Error("waitFor timed out"));
    }, ms);
  });
}

const jobStatus = (id: number) => dbh.repo.getJob(id)!.status;
const stubRunning = (name: string) =>
  client.latest()?.gcodeState === "RUNNING" && client.latest()!.subtaskName.includes(name);

test("MQTT FINISH/FAILED drive the dispatcher (spec ⑦): auto-advance, swap, retry pending", async () => {
  const a = dbh.repo.createJob({ filename: "a" });
  const b = dbh.repo.createJob({ filename: "b" });
  const c = dbh.repo.createJob({ filename: "c" });
  for (const id of [a, b, c]) dbh.repo.updateStatus(id, "queued");

  // dispatch A (real FTPS upload + MQTT project_file) and wait for the stub to run it
  await dispatcher.dispatchNext();
  await waitFor(() => stubRunning("job-" + a + "."));

  // Drive completion over MQTT — the monitor must finish A and auto-advance to B
  printer.forceFinish();
  await waitFor(() => jobStatus(a) === "success" && jobStatus(b) === "printing");
  expect(dbh.repo.getStocker()!.remaining).toBe(9);

  // Second completion, MQTT-driven, advances to C
  await waitFor(() => stubRunning("job-" + b + "."));
  printer.forceFinish();
  await waitFor(() => jobStatus(b) === "success" && jobStatus(c) === "printing");
  expect(dbh.repo.getStocker()!.remaining).toBe(8);

  // A FAILED report must route to onFailed: fail + swap + retry_decision pending
  await waitFor(() => stubRunning("job-" + c + "."));
  printer.forceFail();
  await waitFor(() => jobStatus(c) === "failed");
  expect(dbh.repo.getStocker()!.remaining).toBe(7);
  expect(dbh.repo.getUnresolvedPendingActions().some((p) => p.type === "retry_decision")).toBe(true);
});
