import { describe, expect, test } from "bun:test";
import { createControlApp } from "../../src/stub/control-api.ts";
import { VirtualPrinter } from "../../src/stub/virtual-printer.ts";
import type { StatusReport, Tray } from "../../src/stub/types.ts";

const TRAYS: Tray[] = [{ index: 0, color: "#FF0000FF", type: "PLA", remaining_g: 800 }];

function setup() {
  const printer = new VirtualPrinter(
    { serial: "STUB0001", speedFactor: 6000, fullSpoolGrams: 1000 },
    TRAYS,
  );
  const app = createControlApp({
    printer,
    diagnostics: () => ({
      mqtt_reachable: true,
      ftps_reachable: false,
      developer_mode_enabled: true,
      access_code_valid: true,
    }),
  });
  return { printer, app };
}

function startPrint(printer: VirtualPrinter) {
  printer.receiveProjectFile({
    command: "project_file",
    param: "Metadata/plate_1.gcode",
    url: "ftp:///cache/j.gcode.3mf",
    use_ams: true,
    ams_mapping: [-1, -1, 0, -1],
  });
}

describe("control-api — __control backdoor", () => {
  test("POST /__control/ams/:slot sets tray grams (spec 20.4)", async () => {
    const { printer, app } = setup();
    const res = await app.request("/__control/ams/0", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ remaining_g: 0 }),
    });
    expect(res.status).toBe(200);
    const tray = printer.buildReport().print.ams.ams[0]!.tray.find((t) => t.id === "0")!;
    expect(tray.remain).toBe(0);
  });

  test("POST /__control/finish completes a running print", async () => {
    const { printer, app } = setup();
    startPrint(printer);
    const res = await app.request("/__control/finish", { method: "POST" });
    expect(res.status).toBe(200);
    expect(printer.state).toBe("FINISH");
  });

  test("POST /__control/fault injects a printer fault (spec 20.5)", async () => {
    const { printer, app } = setup();
    startPrint(printer);
    const res = await app.request("/__control/fault", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ category: "printer", timing: "now" }),
    });
    expect(res.status).toBe(200);
    expect(printer.state).toBe("FAILED");
  });

  test("POST /__control/fault rejects missing fields", async () => {
    const { app } = setup();
    const res = await app.request("/__control/fault", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ category: "printer" }),
    });
    expect(res.status).toBe(400);
  });

  test("GET /__control/state returns the live report", async () => {
    const { printer, app } = setup();
    startPrint(printer);
    const res = await app.request("/__control/state");
    const report = (await res.json()) as StatusReport;
    expect(report.print.gcode_state).toBe("RUNNING");
  });
});

describe("control-api — diagnostics (spec 20.7)", () => {
  test("GET /api/diagnostics returns the reachability snapshot", async () => {
    const { app } = setup();
    const res = await app.request("/api/diagnostics");
    expect(res.status).toBe(200);
    const diag = (await res.json()) as { mqtt_reachable: boolean; developer_mode_enabled: boolean };
    expect(diag.mqtt_reachable).toBe(true);
    expect(diag.developer_mode_enabled).toBe(true);
  });

  test("GET /api/printer/snapshot returns a PNG", async () => {
    const { app } = setup();
    const res = await app.request("/api/printer/snapshot");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
  });
});
