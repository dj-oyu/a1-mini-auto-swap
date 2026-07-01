import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VirtualPrinter } from "../../src/stub/virtual-printer.ts";
import { StubMqttServer } from "../../src/stub/mqtt-server.ts";
import { StubFtpsServer } from "../../src/stub/ftps-server.ts";
import { OrchestratorMqttClient } from "../../src/orchestrator/mqtt-client.ts";
import { MqttFtpsPrinter, type ArtifactResolver } from "../../src/orchestrator/mqtt-ftps-printer.ts";
import type { JobRow } from "../../src/db/types.ts";

const SERIAL = "STUB0003";
const ACCESS = "stub-access-code";
const CERT_DIR = join(process.cwd(), "certs");

let printer: VirtualPrinter;
let mqttServer: StubMqttServer;
let ftpsServer: StubFtpsServer;
let client: OrchestratorMqttClient;
let port: MqttFtpsPrinter;
let uploadDir: string;

const resolver: ArtifactResolver = (job) => ({
  bytes: Buffer.from(`dummy 3mf for job ${job.id}`),
  remoteName: `job-${job.id}.gcode.3mf`,
  param: "Metadata/plate_1.gcode",
  url: `ftp:///cache/job-${job.id}.gcode.3mf`,
  amsMapping: [-1, -1, 0, -1],
});

const job = (id: number) => ({ id }) as unknown as JobRow;

beforeAll(async () => {
  uploadDir = mkdtempSync(join(tmpdir(), "orch-io-"));
  printer = new VirtualPrinter({ serial: SERIAL, speedFactor: 60000, fullSpoolGrams: 1000 }, [
    { index: 2, color: "#FF0000FF", type: "PLA", remaining_g: 800 },
  ]);
  mqttServer = new StubMqttServer(printer, { port: 0, certDir: CERT_DIR });
  ftpsServer = new StubFtpsServer({ certDir: CERT_DIR, accessCode: ACCESS, uploadDir });
  const mqttPort = await mqttServer.listen(0);
  const ftpsPort = await ftpsServer.listen(0);

  client = new OrchestratorMqttClient({ url: `mqtts://127.0.0.1:${mqttPort}`, serial: SERIAL, accessCode: ACCESS });
  await client.connect();
  port = new MqttFtpsPrinter(client, { host: "127.0.0.1", port: ftpsPort, accessCode: ACCESS }, resolver);
});

afterAll(async () => {
  await client.close();
  await mqttServer.close();
  await ftpsServer.close();
  rmSync(uploadDir, { recursive: true, force: true });
});

function waitForState(state: string, ms = 3000): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setInterval(() => {
      if (client.latest()?.gcodeState === state) {
        clearInterval(t);
        resolve();
      }
    }, 10);
    setTimeout(() => {
      clearInterval(t);
      reject(new Error(`printer did not reach ${state}; latest=${client.latest()?.gcodeState}`));
    }, ms);
  });
}

test("startPrint uploads via FTPS then starts the print via MQTT (spec 6 dispatch path)", async () => {
  printer.reset();
  await port.startPrint(job(1));

  // FTPS side received the artifact...
  expect(ftpsServer.uploadedFiles()).toContain("job-1.gcode.3mf");
  // ...and MQTT drove the printer to RUNNING, observed back over MQTT.
  await waitForState("RUNNING");
  expect(client.latest()!.subtaskName).toBe("job-1.gcode.3mf");
});

test("a completion is observed over MQTT", async () => {
  printer.forceFinish();
  await waitForState("FINISH");
  expect(client.latest()!.mcPercent).toBe(100);
});

test("ejectAndReset stops the running print (FAILED)", async () => {
  printer.reset();
  await port.startPrint(job(2));
  await waitForState("RUNNING");
  await port.ejectAndReset();
  await waitForState("FAILED");
  expect(client.latest()!.hms.length).toBeGreaterThan(0);
});

test("rejects a non-4-element ams_mapping (INV-MQTT-01)", async () => {
  const badPort = new MqttFtpsPrinter(
    client,
    { host: "127.0.0.1", port: 1, accessCode: ACCESS },
    () => ({ bytes: Buffer.from("x"), remoteName: "x", param: "p", url: "u", amsMapping: [0, 0, 0] }),
  );
  await expect(badPort.startPrint(job(3))).rejects.toThrow(/4 elements/);
});

test("pushAll recovers a missed FINISH after suppression (INV-RESYNC-02)", async () => {
  printer.reset();
  await waitForState("IDLE");
  printer.injectFault({ category: "transient", timing: "on_state_transition:FINISH" });
  await port.startPrint(job(4));
  await waitForState("RUNNING");

  printer.forceFinish(); // FINISH suppressed — no report leaks
  await Bun.sleep(100);
  expect(client.latest()!.gcodeState).toBe("RUNNING"); // client still thinks it's running

  client.pushAll(); // orchestrator full-poll
  await waitForState("FINISH");
});
