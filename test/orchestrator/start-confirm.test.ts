// startPrint must CONFIRM the printer actually started (left IDLE) — the
// project_file ack is not proof (実測 2026-07-03: A1 acks "success" then sets a
// print_error and stays IDLE). On no-start, startPrint throws so the dispatcher
// reverts the job to 'queued' instead of a phantom 'printing'.
import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { MqttFtpsPrinter } from "../../src/orchestrator/mqtt-ftps-printer.ts";
import type { PrinterStatus } from "../../src/orchestrator/mqtt-client.ts";
import type { JobRow } from "../../src/db/types.ts";

/** Minimal OrchestratorMqttClient stand-in: records project_file, lets the test
 *  drive status events, implements waitForStatus like the real one. */
class FakeMqtt extends EventEmitter {
  published: unknown[] = [];
  publishProjectFile(p: unknown): void {
    this.published.push(p);
  }
  stop(): void {}
  waitForStatus(pred: (s: PrinterStatus) => boolean, timeoutMs: number): Promise<PrinterStatus | null> {
    return new Promise((resolve) => {
      const on = (s: PrinterStatus) => {
        if (pred(s)) {
          cleanup();
          resolve(s);
        }
      };
      const t = setTimeout(() => {
        cleanup();
        resolve(null);
      }, timeoutMs);
      const cleanup = () => {
        this.off("status", on);
        clearTimeout(t);
      };
      this.on("status", on);
    });
  }
}

const status = (gcodeState: string): PrinterStatus => ({
  gcodeState,
  mcRemainingTime: 0,
  mcPercent: 0,
  subtaskName: "",
  layerNum: 0,
  totalLayerNum: 0,
  hms: [],
});

const job = (id: number) => ({ id }) as unknown as JobRow;

const mkArtifact = () => ({
  bytes: Buffer.from("PK"),
  remoteName: "job-1.gcode.3mf",
  param: "Metadata/plate_1.gcode",
  url: "ftp:///cache/job-1.gcode.3mf",
  amsMapping: [0, -1, -1, -1],
});

/** Hermetic printer: no-op the FTPS upload so we test ONLY the start-confirm. */
class NoUploadPrinter extends MqttFtpsPrinter {
  protected override async upload(): Promise<void> {
    /* no network */
  }
}

describe("startPrint start-confirmation", () => {
  test("throws when the printer stays IDLE (no start) within the confirm window", async () => {
    const mqtt = new FakeMqtt();
    const printer = new NoUploadPrinter(
      mqtt as never,
      { host: "127.0.0.1", port: 0, accessCode: "x" },
      () => mkArtifact(),
      { confirmStartMs: 150 },
    );
    // Feed IDLE reports during the window — must NOT satisfy the start check.
    const iv = setInterval(() => mqtt.emit("status", status("IDLE")), 20);
    let msg = "";
    try {
      await printer.startPrint(job(1));
    } catch (e) {
      msg = (e as Error).message;
    } finally {
      clearInterval(iv);
    }
    expect(msg).toContain("did not start");
    expect(mqtt.published).toHaveLength(1); // it DID publish; the printer just didn't act
  }, 10_000);

  test("resolves once the printer leaves IDLE (PREPARE/RUNNING)", async () => {
    const mqtt = new FakeMqtt();
    const printer = new NoUploadPrinter(
      mqtt as never,
      { host: "127.0.0.1", port: 0, accessCode: "x" },
      () => mkArtifact(),
      { confirmStartMs: 2_000 },
    );
    setTimeout(() => mqtt.emit("status", status("PREPARE")), 40);
    await printer.startPrint(job(1)); // resolves without throwing
    expect(mqtt.published).toHaveLength(1);
  }, 10_000);

  test("confirmStartMs:0 disables the check (publish-and-return, prior behavior)", async () => {
    const mqtt = new FakeMqtt();
    const printer = new NoUploadPrinter(
      mqtt as never,
      { host: "127.0.0.1", port: 0, accessCode: "x" },
      () => mkArtifact(),
      { confirmStartMs: 0 },
    );
    await printer.startPrint(job(1)); // no status ever emitted; still resolves
    expect(mqtt.published).toHaveLength(1);
  });
});
