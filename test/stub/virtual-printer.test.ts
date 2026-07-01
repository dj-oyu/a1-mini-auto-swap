import { describe, expect, test } from "bun:test";
import { HMS, VirtualPrinter } from "../../src/stub/virtual-printer.ts";
import type { ProjectFileCommand, StatusReport, Tray } from "../../src/stub/types.ts";

const TRAYS: Tray[] = [
  { index: 0, color: "#FF0000FF", type: "PLA", remaining_g: 800 },
  { index: 2, color: "#0000FFFF", type: "PLA", remaining_g: 800 },
];

function makePrinter() {
  return new VirtualPrinter(
    { serial: "STUB0001", speedFactor: 6000, fullSpoolGrams: 1000 },
    TRAYS,
  );
}

function projectFile(over: Partial<ProjectFileCommand> = {}): ProjectFileCommand {
  return {
    sequence_id: "1",
    command: "project_file",
    param: "Metadata/plate_1.gcode",
    url: "ftp:///cache/job-42.gcode.3mf",
    use_ams: true,
    ams_mapping: [-1, -1, 0, -1],
    ...over,
  };
}

/** Collect every report the printer emits during `fn`. */
function captureReports(p: VirtualPrinter, fn: () => void): StatusReport[] {
  const reports: StatusReport[] = [];
  const onReport = (r: StatusReport) => reports.push(r);
  p.on("report", onReport);
  fn();
  p.off("report", onReport);
  return reports;
}

describe("VirtualPrinter — lifecycle", () => {
  test("starts a print from IDLE and reports RUNNING", () => {
    const p = makePrinter();
    expect(p.state).toBe("IDLE");
    const reports = captureReports(p, () => {
      const err = p.receiveProjectFile(projectFile());
      expect(err).toBeNull();
    });
    expect(p.state).toBe("RUNNING");
    const last = reports.at(-1)!;
    expect(last.print.gcode_state).toBe("RUNNING");
    expect(last.print.mc_remaining_time).toBe(10);
    expect(last.print.subtask_name).toBe("job-42.gcode.3mf");
  });

  test("runs to completion via ticks and reaches FINISH (spec 20.3)", () => {
    const p = makePrinter();
    p.receiveProjectFile(projectFile());
    const reports = captureReports(p, () => {
      for (let i = 0; i < 10; i++) p.tick();
    });
    expect(p.state).toBe("FINISH");
    expect(reports.at(-1)!.print.gcode_state).toBe("FINISH");
    expect(reports.at(-1)!.print.mc_percent).toBe(100);
  });

  test("forceFinish jumps straight to FINISH (the __control finish shortcut)", () => {
    const p = makePrinter();
    p.receiveProjectFile(projectFile());
    const reports = captureReports(p, () => p.forceFinish());
    expect(p.state).toBe("FINISH");
    expect(reports.at(-1)!.print.gcode_state).toBe("FINISH");
  });

  test("mc_remaining_time decreases monotonically while RUNNING (spec 10/ETA)", () => {
    const p = makePrinter();
    p.receiveProjectFile(projectFile());
    const times: number[] = [];
    p.on("report", (r: StatusReport) => times.push(r.print.mc_remaining_time));
    for (let i = 0; i < 10; i++) p.tick();
    for (let i = 1; i < times.length; i++) {
      expect(times[i]!).toBeLessThanOrEqual(times[i - 1]!);
    }
  });
});

describe("VirtualPrinter — command validation (INV-MQTT-01)", () => {
  test("rejects ams_mapping that is not exactly 4 elements", () => {
    const p = makePrinter();
    expect(p.receiveProjectFile(projectFile({ ams_mapping: [-1, -1, 0, -1, -1] }))).toMatch(/4 elements/);
    expect(p.receiveProjectFile(projectFile({ ams_mapping: [0] }))).toMatch(/4 elements/);
    expect(p.state).toBe("IDLE");
  });

  test("rejects a new print while already RUNNING", () => {
    const p = makePrinter();
    expect(p.receiveProjectFile(projectFile())).toBeNull();
    expect(p.receiveProjectFile(projectFile())).toMatch(/busy/);
  });
});

describe("VirtualPrinter — fault injection (spec 20.5)", () => {
  test("printer fault now => FAILED with HMS code", () => {
    const p = makePrinter();
    p.receiveProjectFile(projectFile());
    const reports = captureReports(p, () => p.injectFault({ category: "printer", timing: "now" }));
    expect(p.state).toBe("FAILED");
    expect(reports.at(-1)!.print.hms).toEqual([{ attr: 0, code: HMS.PRINTER_FAULT }]);
  });

  test("swap fault next_print => the NEXT dispatched print fails immediately", () => {
    const p = makePrinter();
    p.injectFault({ category: "swap", timing: "next_print" });
    p.receiveProjectFile(projectFile());
    expect(p.state).toBe("FAILED");
    expect(p.buildReport().print.hms).toEqual([{ attr: 0, code: HMS.SWAP_FAULT }]);
  });

  test("on_state_transition:FINISH suppresses the FINISH report, pushAll resurfaces it (INV-RESYNC-01/02)", () => {
    const p = makePrinter();
    p.injectFault({ category: "transient", timing: "on_state_transition:FINISH" });
    p.receiveProjectFile(projectFile());

    const duringFinish = captureReports(p, () => p.forceFinish());
    // State really IS finished internally...
    expect(p.state).toBe("FINISH");
    // ...but no FINISH report leaked out (missed-FINISH disconnect reproduced).
    expect(duringFinish.some((r) => r.print.gcode_state === "FINISH")).toBe(false);

    // A reconnect full-poll must surface the missed completion.
    const resync = p.pushAll();
    expect(resync.print.gcode_state).toBe("FINISH");
  });
});

describe("VirtualPrinter — AMS control (spec 20.4)", () => {
  test("setAms updates a tray and republishes; runout shows remain 0", () => {
    const p = makePrinter();
    const reports = captureReports(p, () => p.setAms(0, { remaining_g: 0 }));
    const tray0 = reports.at(-1)!.print.ams.ams[0]!.tray.find((t) => t.id === "0")!;
    expect(tray0.remain).toBe(0);
  });

  test("grams map to remain percent against fullSpoolGrams", () => {
    const p = makePrinter();
    p.setAms(0, { remaining_g: 500 });
    const tray0 = p.buildReport().print.ams.ams[0]!.tray.find((t) => t.id === "0")!;
    expect(tray0.remain).toBe(50);
  });
});

describe("VirtualPrinter — abort (spec 9)", () => {
  test("stop() on a running print => FAILED", () => {
    const p = makePrinter();
    p.receiveProjectFile(projectFile());
    p.stop();
    expect(p.state).toBe("FAILED");
  });

  test("stop() is a no-op when idle", () => {
    const p = makePrinter();
    p.stop();
    expect(p.state).toBe("IDLE");
  });
});
