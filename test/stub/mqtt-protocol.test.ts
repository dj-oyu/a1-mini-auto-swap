import { afterAll, beforeAll, expect, test } from "bun:test";
import mqtt, { type MqttClient } from "mqtt";
import { join } from "node:path";
import { VirtualPrinter } from "../../src/stub/virtual-printer.ts";
import { StubMqttServer } from "../../src/stub/mqtt-server.ts";
import { reportTopic, requestTopic } from "../../src/stub/topics.ts";
import type { CommandAck, StatusReport, Tray } from "../../src/stub/types.ts";

// Wire-protocol conformance tests: ack shape, INV-MQTT-01, pushall-on-demand,
// malformed-payload resilience, bambuddy field names, and fan-out. Mirrors the
// setup in mqtt-integration.test.ts but does not duplicate its 3 cases.

const SERIAL = "STUB0002";
const CERT_DIR = join(process.cwd(), "certs");
const TRAYS: Tray[] = [{ index: 2, color: "#FF0000FF", type: "PLA", remaining_g: 800 }];

let printer: VirtualPrinter;
let server: StubMqttServer;
let client: MqttClient;
let port: number;
/** Raw parsed payloads off the report topic — both push_status reports and
 *  command acks land here, distinguished at read-time via `print.command`. */
const messages: unknown[] = [];

beforeAll(async () => {
  printer = new VirtualPrinter({ serial: SERIAL, speedFactor: 60000, fullSpoolGrams: 1000 }, TRAYS);
  server = new StubMqttServer(printer, { port: 0, certDir: CERT_DIR });
  port = await server.listen(0);

  client = mqtt.connect(`mqtts://127.0.0.1:${port}`, {
    rejectUnauthorized: false, // self-signed; spec 2 disables cert verification
    username: "bblp",
    password: "stub-access-code",
  });
  client.on("message", (_topic, payload) => {
    messages.push(JSON.parse(payload.toString()));
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

/** Wait until some collected message (at or after `fromIndex`) satisfies
 *  `pred`, else throw on timeout. `fromIndex` matters for "on demand" /
 *  "nothing arrives" assertions where a stale match must not count. */
function waitForMessage<T>(pred: (r: T) => boolean, ms = 2000, fromIndex = 0): Promise<T> {
  return new Promise((resolve, reject) => {
    const search = () => messages.slice(fromIndex).find((m) => pred(m as T)) as T | undefined;
    const found = search();
    if (found) return resolve(found);
    const timer = setInterval(() => {
      const hit = search();
      if (hit) {
        clearInterval(timer);
        resolve(hit);
      }
    }, 10);
    setTimeout(() => {
      clearInterval(timer);
      reject(new Error("timed out waiting for matching message"));
    }, ms);
  });
}

function waitForReport(
  pred: (r: StatusReport) => boolean,
  ms = 2000,
  fromIndex = 0,
): Promise<StatusReport> {
  return waitForMessage<StatusReport>(pred, ms, fromIndex);
}

function waitForAck(pred: (a: CommandAck) => boolean, ms = 2000, fromIndex = 0): Promise<CommandAck> {
  return waitForMessage<CommandAck>(pred, ms, fromIndex);
}

function publishCommand(body: unknown): void {
  client.publish(requestTopic(SERIAL), JSON.stringify(body));
}

/** Reset the printer and wait for *its own* IDLE report to land (delivery is
 *  async over the socket), returning the message index to diff against. A
 *  bare `messages.length` right after reset() would race that in-flight
 *  report and undercount the baseline. */
async function resetAndSettle(): Promise<number> {
  const before = messages.length;
  printer.reset();
  await waitForReport((r) => r.print.command === "push_status" && r.print.gcode_state === "IDLE", 2000, before);
  return messages.length;
}

test("project_file command produces a command ACK on the report topic", async () => {
  printer.reset();
  publishCommand({
    print: {
      sequence_id: "42",
      command: "project_file",
      param: "Metadata/plate_1.gcode",
      url: "ftp:///cache/job-ack.gcode.3mf",
      use_ams: true,
      ams_mapping: [-1, -1, 0, -1],
    },
  });

  const ack = await waitForAck((a) => a.print.command === "project_file" && a.print.sequence_id === "42");
  expect(ack.print.result).toBe("SUCCESS");
  expect(ack.print.msg).toBe(0);
  expect(ack.print.reason).toBeUndefined();
});

test("invalid ams_mapping (5 elements) is rejected with FAILED ack and printer stays IDLE (INV-MQTT-01)", async () => {
  printer.reset();
  publishCommand({
    print: {
      sequence_id: "43",
      command: "project_file",
      param: "Metadata/plate_1.gcode",
      url: "ftp:///cache/job-badmap.gcode.3mf",
      use_ams: true,
      ams_mapping: [-1, -1, 0, -1, 0], // 5 elements — the external-spool trap (spec 9)
    },
  });

  const ack = await waitForAck((a) => a.print.command === "project_file" && a.print.sequence_id === "43");
  expect(ack.print.result).toBe("FAILED");
  expect(ack.print.reason).toBeDefined();
  expect(printer.state).toBe("IDLE");
});

test("stop command produces a command ACK", async () => {
  printer.reset();
  publishCommand({
    print: {
      command: "project_file",
      param: "Metadata/plate_1.gcode",
      url: "ftp:///cache/job-stop.gcode.3mf",
      use_ams: true,
      ams_mapping: [-1, -1, 0, -1],
    },
  });
  await waitForReport(
    (r) => r.print.command === "push_status" && r.print.gcode_state === "RUNNING" && r.print.subtask_name === "job-stop.gcode.3mf",
  );

  publishCommand({ print: { command: "stop", sequence_id: "44" } });
  const ack = await waitForAck((a) => a.print.command === "stop" && a.print.sequence_id === "44");
  expect(ack.print.result).toBe("SUCCESS");
});

test("pushall request returns a full push_status report on demand", async () => {
  const from = await resetAndSettle();
  publishCommand({ pushing: { command: "pushall" } });

  const report = await waitForReport((r) => r.print.command === "push_status", 2000, from);
  expect(report.print.gcode_state).toBe("IDLE");
});

test("malformed non-JSON payload is ignored without crashing the broker", async () => {
  const from = await resetAndSettle();
  client.publish(requestTopic(SERIAL), "{not-valid-json::");
  await Bun.sleep(150);
  expect(messages.slice(from).length).toBe(0);

  // broker must still be alive: a subsequent valid command still works.
  publishCommand({ pushing: { command: "pushall" } });
  const report = await waitForReport((r) => r.print.command === "push_status", 2000, from);
  expect(report.print.gcode_state).toBe("IDLE");
});

test("push_status report matches the bambuddy wire schema (field names)", async () => {
  const from = await resetAndSettle();
  publishCommand({ pushing: { command: "pushall" } });
  const report = await waitForReport((r) => r.print.command === "push_status", 2000, from);

  expect(report.print.command).toBe("push_status");
  expect(typeof report.print.msg).toBe("number");
  expect(Array.isArray(report.print.ams.ams)).toBe(true);
  const ams0 = report.print.ams.ams[0]!;
  expect(ams0.id).toBe("0");
  expect(typeof ams0.humidity).toBe("string");
  expect(typeof ams0.temp).toBe("string");
  expect(Array.isArray(ams0.tray)).toBe(true);
  expect(ams0.tray.length).toBeGreaterThan(0);
  expect(typeof report.print.ams.ams_exist_bits).toBe("string");
  expect(typeof report.print.ams.tray_now).toBe("string");
  expect(typeof report.print.ams.tray_tar).toBe("string");
  expect(Array.isArray(report.print.hms)).toBe(true);
});

test("a second MQTT client subscribing also receives reports (fan-out)", async () => {
  printer.reset();
  const client2 = mqtt.connect(`mqtts://127.0.0.1:${port}`, {
    rejectUnauthorized: false,
    username: "bblp",
    password: "stub-access-code",
  });
  const client2Messages: unknown[] = [];
  client2.on("message", (_topic, payload) => client2Messages.push(JSON.parse(payload.toString())));

  await new Promise<void>((resolve, reject) => {
    client2.once("connect", () => resolve());
    client2.once("error", reject);
  });
  await new Promise<void>((resolve, reject) =>
    client2.subscribe(reportTopic(SERIAL), (err) => (err ? reject(err) : resolve())),
  );

  publishCommand({ pushing: { command: "pushall" } });

  await new Promise<void>((resolve, reject) => {
    const timer = setInterval(() => {
      if (client2Messages.some((m) => (m as StatusReport).print.command === "push_status")) {
        clearInterval(timer);
        resolve();
      }
    }, 10);
    setTimeout(() => {
      clearInterval(timer);
      reject(new Error("second client never received a report"));
    }, 2000);
  });

  await new Promise<void>((resolve) => client2.end(true, {}, () => resolve()));
});

test("tray_now/tray_tar reflect the active job's mapped slot while RUNNING", async () => {
  printer.reset();
  publishCommand({
    print: {
      command: "project_file",
      param: "Metadata/plate_1.gcode",
      url: "ftp:///cache/job-tray.gcode.3mf",
      use_ams: true,
      ams_mapping: [-1, -1, 2, -1], // slot 2 == the seeded tray
    },
  });

  const running = await waitForReport(
    (r) => r.print.command === "push_status" && r.print.gcode_state === "RUNNING" && r.print.subtask_name === "job-tray.gcode.3mf",
  );
  expect(running.print.ams.tray_now).toBe("2");
  expect(running.print.ams.tray_tar).toBe("2");
});

// Deterministic keepalive testing would need control over the negotiated
// interval and wall-clock timing; deferred rather than risking flakiness.
test.todo("respect negotiated MQTT keepalive (spec 20.6)", () => {});
