import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VirtualPrinter } from "../../src/stub/virtual-printer.ts";
import { StubMqttServer } from "../../src/stub/mqtt-server.ts";
import { StubFtpsServer } from "../../src/stub/ftps-server.ts";
import { openDb, type Db } from "../../src/db/index.ts";
import { OrchestratorMqttClient } from "../../src/orchestrator/mqtt-client.ts";
import { MqttFtpsPrinter, type ArtifactResolver } from "../../src/orchestrator/mqtt-ftps-printer.ts";
import type { Notifier, NotifyEvent } from "../../src/core/ports.ts";
import { createOrchestrator, type Orchestrator } from "../../src/orchestrator/orchestrator.ts";

// Regression for the MOSQUITTO_URL opt-in slice: deployments/tests without a
// Mosquitto broker configured must be able to build the orchestrator with NO
// `gateway` at all (main.ts now omits it when MOSQUITTO_URL is unset), and the
// dispatcher/monitor core loop must keep working — the gateway republish is
// simply skipped rather than throwing.

const SERIAL = "STUB0006";
const ACCESS = "stub-access-code";
const CERT_DIR = join(process.cwd(), "certs");

class RecNotifier implements Notifier {
  events: NotifyEvent[] = [];
  notify(e: NotifyEvent): void {
    this.events.push(e);
  }
}

const resolver: ArtifactResolver = (job) => ({
  bytes: Buffer.from(`3mf ${job.id}`),
  remoteName: `job-${job.id}.gcode.3mf`,
  param: "Metadata/plate_1.gcode",
  url: `ftp:///cache/job-${job.id}.gcode.3mf`,
  amsMapping: [-1, -1, 0, -1],
});

let printer: VirtualPrinter;
let mqttServer: StubMqttServer;
let ftpsServer: StubFtpsServer;
let client: OrchestratorMqttClient;
let dbh: Db;
let orch: Orchestrator;
let rec: RecNotifier;
let uploadDir: string;

beforeAll(async () => {
  uploadDir = mkdtempSync(join(tmpdir(), "orch-no-gw-"));
  printer = new VirtualPrinter({ serial: SERIAL, speedFactor: 60000, fullSpoolGrams: 1000 }, [
    { index: 2, color: "#FF0000FF", type: "PLA", remaining_g: 2000 },
  ]);
  mqttServer = new StubMqttServer(printer, { port: 0, certDir: CERT_DIR });
  ftpsServer = new StubFtpsServer({ certDir: CERT_DIR, accessCode: ACCESS, uploadDir });
  const mqttPort = await mqttServer.listen(0);
  const ftpsPort = await ftpsServer.listen(0);

  client = new OrchestratorMqttClient({ url: `mqtts://127.0.0.1:${mqttPort}`, serial: SERIAL, accessCode: ACCESS });
  await client.connect();

  dbh = openDb(":memory:");
  dbh.repo.setStocker(10, 10);
  const printerPort = new MqttFtpsPrinter(client, { host: "127.0.0.1", port: ftpsPort, accessCode: ACCESS }, resolver);
  rec = new RecNotifier();

  // No `gateway` key at all — this is the shape main.ts now produces when
  // MOSQUITTO_URL is unset.
  orch = createOrchestrator({ repo: dbh.repo, printer: printerPort, notifier: rec, status: client });
});

afterAll(async () => {
  orch.monitor.stop();
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

test("createOrchestrator without a gateway: dispatch/monitor still work, republishQueue is a no-op", async () => {
  // republishQueue must not throw even before any dispatch happens.
  expect(() => orch.republishQueue()).not.toThrow();

  const id = dbh.repo.createJob({ filename: "plate.3mf" });
  dbh.repo.updateStatus(id, "queued");

  await orch.dispatcher.dispatchNext();
  expect(dbh.repo.getJob(id)!.status).toBe("printing");

  await waitFor(() => client.latest()?.gcodeState === "RUNNING");

  printer.forceFinish();
  await waitFor(() => dbh.repo.getJob(id)!.status === "success");
  expect(dbh.repo.getStocker()!.remaining).toBe(9); // swap on completion, unaffected by gateway absence

  expect(rec.events.some((e) => e.type === "job_finished" && e.jobId === id)).toBe(true);
});
