import { describe, expect, test } from "bun:test";
import { createControlApp } from "../../src/stub/control-api.ts";
import { HMS, VirtualPrinter } from "../../src/stub/virtual-printer.ts";
import type { StatusReport, Tray } from "../../src/stub/types.ts";

// Edge-case coverage for the __control backdoor (spec 20.4/20.5) and the
// diagnostics/snapshot endpoints (spec 20.7/20.2). Mirrors the setup() helper
// from control-api.test.ts; does not repeat cases already covered there.

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
  return printer.receiveProjectFile({
    command: "project_file",
    param: "Metadata/plate_1.gcode",
    url: "ftp:///cache/j.gcode.3mf",
    use_ams: true,
    ams_mapping: [-1, -1, 0, -1],
  });
}

describe("control-api edge — POST /__control/ams/:slot (spec 20.4)", () => {
  test("non-numeric slot => 400", async () => {
    const { app } = setup();
    const res = await app.request("/__control/ams/abc", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ remaining_g: 100 }),
    });
    expect(res.status).toBe(400);
  });

  test("negative slot => 400", async () => {
    const { app } = setup();
    const res = await app.request("/__control/ams/-1", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ remaining_g: 100 }),
    });
    expect(res.status).toBe(400);
  });

  test("partial body (color only) updates color, leaves type/remaining_g untouched", async () => {
    const { printer, app } = setup();
    const res = await app.request("/__control/ams/0", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ color: "#00FF00FF" }),
    });
    expect(res.status).toBe(200);
    const tray = printer.buildReport().print.ams.ams[0]!.tray.find((t) => t.id === "0")!;
    expect(tray.tray_color).toBe("#00FF00FF");
    expect(tray.tray_type).toBe("PLA"); // untouched
    expect(tray.remain).toBe(80); // 800/1000g untouched
  });

  test("partial body (type only) updates type, leaves color/remaining_g untouched", async () => {
    const { printer, app } = setup();
    const res = await app.request("/__control/ams/0", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "PETG" }),
    });
    expect(res.status).toBe(200);
    const tray = printer.buildReport().print.ams.ams[0]!.tray.find((t) => t.id === "0")!;
    expect(tray.tray_type).toBe("PETG");
    expect(tray.tray_color).toBe("#FF0000FF"); // untouched
    expect(tray.remain).toBe(80); // untouched
  });

  test("brand-new slot index is appended", async () => {
    const { printer, app } = setup();
    const res = await app.request("/__control/ams/2", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ color: "#0000FFFF" }),
    });
    expect(res.status).toBe(200);
    const trays = printer.buildReport().print.ams.ams[0]!.tray;
    expect(trays.map((t) => t.id)).toEqual(["0", "2"]);
    const newTray = trays.find((t) => t.id === "2")!;
    expect(newTray.tray_color).toBe("#0000FFFF");
    expect(newTray.tray_type).toBe(""); // defaulted
    expect(newTray.remain).toBe(-1); // type "" and remaining_g 0 => unknown
  });
});

describe("control-api edge — POST /__control/fault (spec 20.5)", () => {
  test("missing category => 400", async () => {
    const { app } = setup();
    const res = await app.request("/__control/fault", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ timing: "next_print" }),
    });
    expect(res.status).toBe(400);
  });

  test("missing timing => 400", async () => {
    const { app } = setup();
    const res = await app.request("/__control/fault", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ category: "swap" }),
    });
    expect(res.status).toBe(400);
  });

  test("category=swap, timing=now while RUNNING => FAILED with SWAP_FAULT code", async () => {
    const { printer, app } = setup();
    startPrint(printer);
    const res = await app.request("/__control/fault", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ category: "swap", timing: "now" }),
    });
    expect(res.status).toBe(200);
    expect(printer.state).toBe("FAILED");
    expect(printer.buildReport().print.hms[0]?.code).toBe(HMS.SWAP_FAULT);
  });

  test("category=transient, timing=now while RUNNING => FAILED with PRINTER_FAULT code", async () => {
    const { printer, app } = setup();
    startPrint(printer);
    const res = await app.request("/__control/fault", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ category: "transient", timing: "now" }),
    });
    expect(res.status).toBe(200);
    expect(printer.state).toBe("FAILED");
    expect(printer.buildReport().print.hms[0]?.code).toBe(HMS.PRINTER_FAULT);
  });

  test("timing=next_print defers the fault until the next print starts", async () => {
    const { printer, app } = setup();
    const res = await app.request("/__control/fault", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ category: "swap", timing: "next_print" }),
    });
    expect(res.status).toBe(200);
    expect(printer.state).toBe("IDLE"); // no immediate effect
    startPrint(printer);
    expect(printer.state).toBe("FAILED");
    expect(printer.buildReport().print.hms[0]?.code).toBe(HMS.SWAP_FAULT);
  });

  test("timing=on_state_transition:FINISH reflects FINISH state on the next full poll", async () => {
    const { printer, app } = setup();
    startPrint(printer);
    const res = await app.request("/__control/fault", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ category: "printer", timing: "on_state_transition:FINISH" }),
    });
    expect(res.status).toBe(200);
    printer.forceFinish();
    // buildReport() always reflects true state, even though the FINISH
    // report emission itself is suppressed (spec 20.5, INV-RESYNC-01/02).
    const stateRes = await app.request("/__control/state");
    const report = (await stateRes.json()) as StatusReport;
    expect(report.print.gcode_state).toBe("FINISH");
  });
});

describe("control-api edge — POST /__control/speed", () => {
  test("missing factor => 400", async () => {
    const { app } = setup();
    const res = await app.request("/__control/speed", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  test("factor <= 0 => 400", async () => {
    const { app } = setup();
    const res = await app.request("/__control/speed", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ factor: 0 }),
    });
    expect(res.status).toBe(400);
    const res2 = await app.request("/__control/speed", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ factor: -5 }),
    });
    expect(res2.status).toBe(400);
  });

  test("valid factor => 200 and changes tickIntervalMs", async () => {
    const { printer, app } = setup();
    const before = printer.tickIntervalMs; // 60000/6000 = 10
    const res = await app.request("/__control/speed", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ factor: 500 }),
    });
    expect(res.status).toBe(200);
    expect(printer.tickIntervalMs).toBe(120); // 60000/500
    expect(printer.tickIntervalMs).not.toBe(before);
  });
});

describe("control-api edge — POST /__control/print_minutes", () => {
  test("missing minutes => 400", async () => {
    const { app } = setup();
    const res = await app.request("/__control/print_minutes", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  test("minutes <= 0 => 400", async () => {
    const { app } = setup();
    const res = await app.request("/__control/print_minutes", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ minutes: -1 }),
    });
    expect(res.status).toBe(400);
  });

  test("valid minutes => 200 and updates the active job's remaining time", async () => {
    const { printer, app } = setup();
    startPrint(printer);
    const res = await app.request("/__control/print_minutes", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ minutes: 5 }),
    });
    expect(res.status).toBe(200);
    const report = printer.buildReport().print;
    expect(report.mc_remaining_time).toBe(5);
    expect(report.total_layer_num).toBe(5);
  });
});

describe("control-api edge — POST /__control/finish", () => {
  test("no-op when IDLE (no active print)", async () => {
    const { printer, app } = setup();
    expect(printer.state).toBe("IDLE");
    const res = await app.request("/__control/finish", { method: "POST" });
    expect(res.status).toBe(200);
    expect(printer.state).toBe("IDLE"); // unchanged, no crash
  });
});

describe("control-api edge — POST /__control/fail", () => {
  test("default code when body is empty", async () => {
    const { printer, app } = setup();
    const res = await app.request("/__control/fail", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(200);
    expect(printer.state).toBe("FAILED");
    expect(printer.buildReport().print.hms[0]?.code).toBe(HMS.PRINTER_FAULT);
  });

  test("custom code appears in the state report", async () => {
    const { printer, app } = setup();
    const customCode = 0x0500_1234;
    const res = await app.request("/__control/fail", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: customCode }),
    });
    expect(res.status).toBe(200);
    const stateRes = await app.request("/__control/state");
    const report = (await stateRes.json()) as StatusReport;
    expect(report.print.hms[0]?.code).toBe(customCode);
  });
});

describe("control-api edge — POST /__control/reset", () => {
  test("returns state IDLE and clears an in-progress print", async () => {
    const { printer, app } = setup();
    startPrint(printer);
    expect(printer.state).toBe("RUNNING");
    const res = await app.request("/__control/reset", { method: "POST" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { state: string };
    expect(body.state).toBe("IDLE");
    expect(printer.state).toBe("IDLE");
    const report = printer.buildReport().print;
    expect(report.subtask_name).toBe(""); // activeJob cleared
    expect(report.mc_remaining_time).toBe(0);
    expect(report.mc_percent).toBe(0);
  });
});

describe("control-api edge — GET /__control/state", () => {
  test("reflects live mutations after a print starts directly on the printer", async () => {
    const { printer, app } = setup();
    const err = startPrint(printer);
    expect(err).toBeNull();
    const res = await app.request("/__control/state");
    const report = (await res.json()) as StatusReport;
    expect(report.print.gcode_state).toBe("RUNNING");
    expect(report.print.subtask_name).toBe("j.gcode.3mf"); // derived from url, not param
    expect(report.print.sequence_id).toBe("0"); // no sequence_id given -> unchanged default
  });
});

describe("control-api edge — GET /api/diagnostics (spec 20.7)", () => {
  test("returns the exact snapshot shape", async () => {
    const printer = new VirtualPrinter(
      { serial: "STUB0002", speedFactor: 6000, fullSpoolGrams: 1000 },
      TRAYS,
    );
    const app = createControlApp({
      printer,
      diagnostics: () => ({
        mqtt_reachable: false,
        ftps_reachable: true,
        developer_mode_enabled: false,
        access_code_valid: false,
      }),
    });
    const res = await app.request("/api/diagnostics");
    expect(res.status).toBe(200);
    const diag = await res.json();
    expect(diag).toEqual({
      mqtt_reachable: false,
      ftps_reachable: true,
      developer_mode_enabled: false,
      access_code_valid: false,
    });
  });
});

describe("control-api edge — GET /api/printer/snapshot (spec 20.2)", () => {
  test("returns a non-empty PNG body", async () => {
    const { app } = setup();
    const res = await app.request("/api/printer/snapshot");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect(bytes.length).toBeGreaterThan(0);
    // PNG magic number: 89 50 4E 47 0D 0A 1A 0A
    expect(Array.from(bytes.slice(0, 8))).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  });
});
