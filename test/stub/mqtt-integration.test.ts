import { afterAll, beforeAll, expect, test } from "bun:test";
import mqtt, { type MqttClient } from "mqtt";
import { join } from "node:path";
import { VirtualPrinter } from "../../src/stub/virtual-printer.ts";
import { StubMqttServer } from "../../src/stub/mqtt-server.ts";
import { reportTopic, requestTopic } from "../../src/stub/topics.ts";
import type { StatusReport, Tray } from "../../src/stub/types.ts";

const SERIAL = "STUB0001";
const CERT_DIR = join(process.cwd(), "certs");
const TRAYS: Tray[] = [{ index: 2, color: "#FF0000FF", type: "PLA", remaining_g: 800 }];

let printer: VirtualPrinter;
let server: StubMqttServer;
let client: MqttClient;
const reports: StatusReport[] = [];

beforeAll(async () => {
  printer = new VirtualPrinter({ serial: SERIAL, speedFactor: 60000, fullSpoolGrams: 1000 }, TRAYS);
  server = new StubMqttServer(printer, { port: 0, certDir: CERT_DIR });
  const port = await server.listen(0);

  client = mqtt.connect(`mqtts://127.0.0.1:${port}`, {
    rejectUnauthorized: false, // self-signed; spec 2 disables cert verification
    username: "bblp",
    password: "stub-access-code",
  });
  client.on("message", (_topic, payload) => {
    reports.push(JSON.parse(payload.toString()) as StatusReport);
  });

  await new Promise<void>((resolve, reject) => {
    client.once("connect", () => resolve());
    client.once("error", reject);
  });
  await new Promise<void>((resolve, reject) =>
    client.subscribe(reportTopic(SERIAL), (err) => (err ? reject(err) : resolve())),
  );
});

afterAll(async () => {
  await new Promise<void>((resolve) => client.end(true, {}, () => resolve()));
  await server.close();
});

/** Wait until some collected report satisfies `pred`, else throw on timeout. */
function waitForReport(pred: (r: StatusReport) => boolean, ms = 2000): Promise<StatusReport> {
  return new Promise((resolve, reject) => {
    const found = reports.find(pred);
    if (found) return resolve(found);
    const timer = setInterval(() => {
      const hit = reports.find(pred);
      if (hit) {
        clearInterval(timer);
        resolve(hit);
      }
    }, 10);
    setTimeout(() => {
      clearInterval(timer);
      reject(new Error("timed out waiting for matching report"));
    }, ms);
  });
}

function publishCommand(body: unknown): void {
  client.publish(requestTopic(SERIAL), JSON.stringify(body));
}

test("orchestrator can start a print over MQTT and observe RUNNING then FINISH (Phase 1 完了条件)", async () => {
  publishCommand({
    print: {
      sequence_id: "7",
      command: "project_file",
      param: "Metadata/plate_1.gcode",
      url: "ftp:///cache/job-7.gcode.3mf",
      use_ams: true,
      ams_mapping: [-1, -1, 0, -1],
    },
  });

  const running = await waitForReport((r) => r.print.gcode_state === "RUNNING");
  expect(running.print.mc_remaining_time).toBeGreaterThan(0);
  expect(running.print.subtask_name).toBe("job-7.gcode.3mf");

  // Drive completion deterministically (the __control finish path).
  printer.forceFinish();
  const finished = await waitForReport((r) => r.print.gcode_state === "FINISH");
  expect(finished.print.mc_percent).toBe(100);
});

test("a stop command over MQTT fails the running print", async () => {
  printer.reset();
  publishCommand({
    print: {
      command: "project_file",
      param: "Metadata/plate_1.gcode",
      url: "ftp:///cache/job-8.gcode.3mf",
      use_ams: true,
      ams_mapping: [-1, -1, 0, -1],
    },
  });
  await waitForReport((r) => r.print.gcode_state === "RUNNING" && r.print.subtask_name === "job-8.gcode.3mf");

  publishCommand({ print: { command: "stop" } });
  const failed = await waitForReport((r) => r.print.gcode_state === "FAILED");
  expect(failed.print.hms.length).toBeGreaterThan(0);
});

test("pushall full-poll resurfaces a missed FINISH (INV-RESYNC-02)", async () => {
  printer.reset();
  printer.injectFault({ category: "transient", timing: "on_state_transition:FINISH" });
  publishCommand({
    print: {
      command: "project_file",
      param: "Metadata/plate_1.gcode",
      url: "ftp:///cache/job-9.gcode.3mf",
      use_ams: true,
      ams_mapping: [-1, -1, 0, -1],
    },
  });
  await waitForReport((r) => r.print.gcode_state === "RUNNING" && r.print.subtask_name === "job-9.gcode.3mf");

  const before = reports.length;
  printer.forceFinish(); // FINISH happens but its report is suppressed
  await Bun.sleep(100);
  expect(reports.slice(before).some((r) => r.print.gcode_state === "FINISH")).toBe(false);

  // The orchestrator's reconnect full-poll must recover it.
  publishCommand({ pushing: { command: "pushall" } });
  const resynced = await waitForReport(
    (r) => r.print.gcode_state === "FINISH" && r.print.subtask_name === "job-9.gcode.3mf",
  );
  expect(resynced.print.gcode_state).toBe("FINISH");
});
