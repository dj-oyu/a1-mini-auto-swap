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
import { PrintfarmGateway, type MqttPublisher } from "../../src/orchestrator/gateway.ts";
import { CompositeNotifier } from "../../src/core/composite-notifier.ts";
import type { Notifier, NotifyEvent } from "../../src/core/ports.ts";
import { createOrchestrator, type Orchestrator } from "../../src/orchestrator/orchestrator.ts";

const SERIAL = "STUB0005";
const ACCESS = "stub-access-code";
const CERT_DIR = join(process.cwd(), "certs");

class RecNotifier implements Notifier {
  events: NotifyEvent[] = [];
  notify(e: NotifyEvent): void {
    this.events.push(e);
  }
}
class FakePublisher implements MqttPublisher {
  msgs: Array<{ topic: string; payload: any; retain: boolean }> = [];
  publish(topic: string, payload: string, opts?: { retain?: boolean }): void {
    this.msgs.push({ topic, payload: JSON.parse(payload), retain: opts?.retain ?? false });
  }
  topics() {
    return this.msgs.map((m) => m.topic);
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
let pub: FakePublisher;
let uploadDir: string;

beforeAll(async () => {
  uploadDir = mkdtempSync(join(tmpdir(), "orch-e2e-"));
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
  pub = new FakePublisher();
  const gateway = new PrintfarmGateway(pub, { now: () => 1_700_000_000_000 });
  const notifier = new CompositeNotifier([rec, gateway]);

  orch = createOrchestrator({ repo: dbh.repo, printer: printerPort, notifier, gateway, status: client });
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

test("full vertical: dispatch → stub → monitor → notifier fan-out + gateway republish", async () => {
  const id = dbh.repo.createJob({ filename: "plate.3mf" });
  dbh.repo.updateStatus(id, "queued");

  // dispatch drives a real FTPS upload + MQTT project_file to the stub
  await orch.dispatcher.dispatchNext();
  expect(dbh.repo.getJob(id)!.status).toBe("printing");

  // wait until the stub is actually RUNNING (project_file arrives async) before finishing
  await waitFor(() => client.latest()?.gcodeState === "RUNNING");

  // completing over MQTT flows through the Monitor → Dispatcher.onFinished
  printer.forceFinish();
  await waitFor(() => dbh.repo.getJob(id)!.status === "success");
  expect(dbh.repo.getStocker()!.remaining).toBe(9); // swap on completion

  // notifier fan-out: job_finished reached the recording notifier...
  expect(rec.events.some((e) => e.type === "job_finished" && e.jobId === id)).toBe(true);
  // ...and the gateway republished to printfarm/* (event + retained queue snapshot)
  await waitFor(() => pub.topics().includes("printfarm/event") && pub.topics().includes("printfarm/queue"));
  const event = pub.msgs.find((m) => m.topic === "printfarm/event")!;
  expect(event.payload.type).toBe("job_finished");
  const queue = pub.msgs.filter((m) => m.topic === "printfarm/queue").at(-1)!;
  expect(queue.retain).toBe(true);
  expect(queue.payload.jobs.some((j: any) => j.id === id && j.status === "success")).toBe(true);
  expect(queue.payload.stocker.remaining).toBe(9);
});
