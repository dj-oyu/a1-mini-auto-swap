// Edge-case characterization tests for VirtualPrinter (spec 20.3/20.4/20.5).
// Complements test/stub/virtual-printer.test.ts — do not re-cover cases already
// exercised there (basic lifecycle, ams_mapping validation, swap-fault next_print,
// FINISH suppression + pushAll resync, setAms runout/percent basics, stop() while
// RUNNING/IDLE). This file focuses on math precision across full runs, control
// backdoor edge cases (spec 20.4), and a couple of genuine discrepancies found
// while probing the implementation (marked `// SUSPECT:`).

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

describe("VirtualPrinter — tick math over a full run (spec 20.3)", () => {
  test("mc_percent/layer_num/mc_remaining_time progress linearly, 100% only on the final tick", () => {
    const p = makePrinter();
    p.receiveProjectFile(projectFile()); // total = 10 sim-minutes (fixed default)
    const percents: number[] = [];
    const layers: number[] = [];
    const remains: number[] = [];
    p.on("report", (r: StatusReport) => {
      percents.push(r.print.mc_percent);
      layers.push(r.print.layer_num);
      remains.push(r.print.mc_remaining_time);
    });

    for (let i = 0; i < 9; i++) p.tick(); // 9 of 10 minutes
    expect(percents).toEqual([10, 20, 30, 40, 50, 60, 70, 80, 90]);
    expect(layers).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(remains).toEqual([9, 8, 7, 6, 5, 4, 3, 2, 1]);
    expect(percents.some((pct) => pct === 100)).toBe(false); // not yet done
    expect(p.state).toBe("RUNNING");

    p.tick(); // the 10th and final tick -> FINISH
    expect(percents.at(-1)).toBe(100);
    expect(layers.at(-1)).toBe(10);
    expect(remains.at(-1)).toBe(0);
    expect(p.state).toBe("FINISH");
  });
});

describe("VirtualPrinter — setPrintMinutes (spec 20.4 control backdoor)", () => {
  test("overrides mc_remaining_time/total_layer_num immediately while RUNNING", () => {
    const p = makePrinter();
    p.receiveProjectFile(projectFile()); // total=10, remaining=10
    p.tick();
    p.tick();
    p.tick(); // remaining=7, 3 minutes elapsed
    expect(p.buildReport().print.mc_remaining_time).toBe(7);

    p.setPrintMinutes(5);
    const report = p.buildReport();
    // NOTE: current behavior sets mc_remaining_time to the new total directly
    // (not proportionally reduced by elapsed time) — it's a "shorten the rest
    // of this print to N minutes" control, not a total-length edit.
    expect(report.print.mc_remaining_time).toBe(5);
    expect(report.print.total_layer_num).toBe(5);

    // subsequent ticks are computed against the *new* total
    p.tick();
    const r2 = p.buildReport();
    expect(r2.print.mc_remaining_time).toBe(4);
    expect(r2.print.mc_percent).toBe(20); // round((5-4)/5 * 100)
  });

  test("is a no-op when there is no active job (e.g. before any print starts)", () => {
    const p = makePrinter();
    p.setPrintMinutes(3);
    expect(p.buildReport().print.mc_remaining_time).toBe(0);
    expect(p.state).toBe("IDLE");
  });
});

describe("VirtualPrinter — tickIntervalMs / speed factor (spec 20.3)", () => {
  test("tickIntervalMs derives from speedFactor as round(60000 / factor)", () => {
    const p = makePrinter(); // speedFactor 6000
    expect(p.tickIntervalMs).toBe(10);
    p.setSpeedFactor(3000);
    expect(p.currentSpeedFactor).toBe(3000);
    expect(p.tickIntervalMs).toBe(20);
    p.setSpeedFactor(100);
    expect(p.tickIntervalMs).toBe(600);
  });

  test("tickIntervalMs floors at 1ms for very large speed factors", () => {
    const p = makePrinter();
    p.setSpeedFactor(1_000_000);
    expect(p.tickIntervalMs).toBe(1);
  });

  test("setSpeedFactor guards factor <= 0 and keeps the previous value", () => {
    const p = makePrinter();
    p.setSpeedFactor(0);
    expect(p.currentSpeedFactor).toBe(6000);
    p.setSpeedFactor(-100);
    expect(p.currentSpeedFactor).toBe(6000);
  });
});

describe("VirtualPrinter — sequential prints", () => {
  test("start -> forceFinish -> reset -> start again yields a clean second run", () => {
    const p = makePrinter();
    p.receiveProjectFile(projectFile({ sequence_id: "1" }));
    p.forceFinish();
    expect(p.state).toBe("FINISH");

    p.reset();
    expect(p.state).toBe("IDLE");
    expect(p.buildReport().print.subtask_name).toBe("");

    const err = p.receiveProjectFile(
      projectFile({ sequence_id: "2", url: "ftp:///cache/job-99.gcode.3mf" }),
    );
    expect(err).toBeNull();
    expect(p.state).toBe("RUNNING");
    const report = p.buildReport();
    expect(report.print.subtask_name).toBe("job-99.gcode.3mf");
    expect(report.print.mc_remaining_time).toBe(10);
    expect(report.print.mc_percent).toBe(0);
    expect(report.print.layer_num).toBe(0);
    expect(report.print.sequence_id).toBe("2");
  });
});

describe("VirtualPrinter — stop() edge states (spec 9)", () => {
  test("stop() is a no-op once FINISHed", () => {
    const p = makePrinter();
    p.receiveProjectFile(projectFile());
    p.forceFinish();
    p.stop();
    expect(p.state).toBe("FINISH");
  });

  test("stop() is a no-op once FAILED", () => {
    const p = makePrinter();
    p.receiveProjectFile(projectFile());
    p.forceFail();
    p.stop();
    expect(p.state).toBe("FAILED");
  });

  // SUSPECT: stop()'s guard is `gcodeState !== "RUNNING" && gcodeState !== "PAUSE"`,
  // but no method in this class ever sets gcodeState to "PAUSE" — there is no
  // pause()/resume() API, and receiveProjectFile only drives PREPARE -> RUNNING.
  // The PAUSE branch of stop() is currently dead code; "stop() from PAUSE" cannot
  // be exercised through the public API at all.
  test("PAUSE is unreachable via the public API across a full lifecycle", () => {
    const p = makePrinter();
    p.receiveProjectFile(projectFile());
    for (let i = 0; i < 10; i++) p.tick();
    expect(p.state).not.toBe("PAUSE");
  });
});

describe("VirtualPrinter — fault injection edge cases (spec 20.5)", () => {
  test("injectFault 'now' while IDLE sets hms without crashing and does not start a print", () => {
    const p = makePrinter();
    const reports = captureReports(p, () =>
      p.injectFault({ category: "printer", timing: "now" }),
    );
    expect(p.state).toBe("IDLE");
    expect(reports.at(-1)!.print.hms).toEqual([{ attr: 0, code: HMS.PRINTER_FAULT }]);
  });

  test("injectFault next_print with category 'printer' also fails the next print, with PRINTER_FAULT", () => {
    const p = makePrinter();
    p.injectFault({ category: "printer", timing: "next_print" });
    p.receiveProjectFile(projectFile());
    expect(p.state).toBe("FAILED");
    expect(p.buildReport().print.hms).toEqual([{ attr: 0, code: HMS.PRINTER_FAULT }]);
  });
});

describe("VirtualPrinter — AMS report bookkeeping (spec 20.4/9)", () => {
  test("tray_exist_bits reflects only trays with remaining_g > 0, as a hex bitfield", () => {
    const p = makePrinter(); // trays at index 0 and 2, both 800g -> bits 0b0101
    expect(p.buildReport().print.ams.tray_exist_bits).toBe("5");

    p.setAms(0, { remaining_g: 0 }); // index 0 empties -> bits 0b0100
    expect(p.buildReport().print.ams.tray_exist_bits).toBe("4");

    p.setAms(1, { type: "PLA", color: "#00FF00FF", remaining_g: 300 }); // index 1 fills -> bits 0b0110
    expect(p.buildReport().print.ams.tray_exist_bits).toBe("6");
  });

  test("tray_now/tray_tar are '255' when idle, else the first non-negative ams_mapping slot", () => {
    const p = makePrinter();
    expect(p.buildReport().print.ams.tray_now).toBe("255");
    expect(p.buildReport().print.ams.tray_tar).toBe("255");

    p.receiveProjectFile(projectFile({ ams_mapping: [-1, -1, 0, -1] }));
    expect(p.buildReport().print.ams.tray_now).toBe("0");
    expect(p.buildReport().print.ams.tray_tar).toBe("0");
  });

  test("tray_now picks the first non-negative mapping entry, not necessarily slot 0", () => {
    const p = makePrinter();
    p.receiveProjectFile(projectFile({ ams_mapping: [-1, 3, 0, -1] }));
    expect(p.buildReport().print.ams.tray_now).toBe("3");
  });

  test("tray_now returns to '255' after reset() clears the active job", () => {
    const p = makePrinter();
    p.receiveProjectFile(projectFile());
    p.forceFinish();
    p.reset();
    expect(p.buildReport().print.ams.tray_now).toBe("255");
  });
});

describe("VirtualPrinter — gramsToRemainPercent (spec 20.4)", () => {
  test("a full spool reports 100 percent", () => {
    const p = makePrinter(); // fullSpoolGrams = 1000
    p.setAms(0, { remaining_g: 1000 });
    const tray = p.buildReport().print.ams.ams[0]!.tray.find((t) => t.id === "0")!;
    expect(tray.remain).toBe(100);
  });

  test("over-full remaining_g clamps to 100 percent", () => {
    const p = makePrinter();
    p.setAms(0, { remaining_g: 1500 });
    const tray = p.buildReport().print.ams.ams[0]!.tray.find((t) => t.id === "0")!;
    expect(tray.remain).toBe(100);
  });

  test("an untyped, empty tray (type '' and 0g) reports remain -1 (unknown), not 0", () => {
    const p = makePrinter();
    p.setAms(3, {}); // new slot, defaults: color "", type "", remaining_g 0
    const tray3 = p.buildReport().print.ams.ams[0]!.tray.find((t) => t.id === "3")!;
    expect(tray3.remain).toBe(-1);
  });

  test("mid-range grams round to the nearest percent", () => {
    const p = makePrinter();
    p.setAms(0, { remaining_g: 333 }); // 33.3% -> 33
    expect(
      p.buildReport().print.ams.ams[0]!.tray.find((t) => t.id === "0")!.remain,
    ).toBe(33);

    p.setAms(2, { remaining_g: 335 }); // 33.5% -> 34 (Math.round half-up)
    expect(
      p.buildReport().print.ams.ams[0]!.tray.find((t) => t.id === "2")!.remain,
    ).toBe(34);
  });
});

describe("VirtualPrinter — pushAll() and FINISH suppression (INV-RESYNC-01/02)", () => {
  test("pushAll() clears suppression so later normal reports flow again", () => {
    const p = makePrinter();
    p.injectFault({ category: "transient", timing: "on_state_transition:FINISH" });
    p.receiveProjectFile(projectFile());
    p.forceFinish(); // suppressed: no FINISH report leaks (see base test file)

    p.pushAll(); // clears finishReportSuppressed and surfaces the true state

    const reports = captureReports(p, () => p.setAms(0, { remaining_g: 100 }));
    expect(reports.length).toBe(1);
    expect(
      reports[0]!.print.ams.ams[0]!.tray.find((t) => t.id === "0")!.remain,
    ).toBe(10);
  });

  // FIXED (was SUSPECT): reset() now clears `finishReportSuppressed`, so resetting
  // directly after a suppressed FINISH — without an intervening pushAll() — emits
  // the IDLE transition instead of swallowing it. A caller that resets a printer
  // which missed its FINISH report still sees the IDLE report.
  test("reset() right after a suppressed FINISH emits its IDLE report", () => {
    const p = makePrinter();
    p.injectFault({ category: "transient", timing: "on_state_transition:FINISH" });
    p.receiveProjectFile(projectFile());
    p.forceFinish();

    const reports = captureReports(p, () => p.reset());
    expect(p.state).toBe("IDLE");
    expect(reports.length).toBe(1);
    expect(reports[0]!.print.gcode_state).toBe("IDLE");
  });
});

describe("VirtualPrinter — reset() (spec 20.4)", () => {
  test("clears activeJob, mc_percent/layer_num/total_layer_num, and temps back to idle", () => {
    const p = makePrinter();
    p.receiveProjectFile(projectFile());
    p.tick();
    p.forceFinish();
    p.reset();
    const report = p.buildReport();
    expect(report.print.gcode_state).toBe("IDLE");
    expect(report.print.subtask_name).toBe("");
    expect(report.print.mc_percent).toBe(0);
    expect(report.print.layer_num).toBe(0);
    expect(report.print.total_layer_num).toBe(0);
    expect(report.print.mc_remaining_time).toBe(0);
    expect(report.print.nozzle_temper).toBe(25);
    expect(report.print.bed_temper).toBe(25);
  });

  // FIXED (was SUSPECT): reset() now clears `this.hms`, so an idle printer no longer
  // advertises a prior FAILED print's HMS code. A caller polling between reset() and
  // the next print sees a clean, healthy IDLE printer.
  test("clears stale hms from a prior FAILED print", () => {
    const p = makePrinter();
    p.receiveProjectFile(projectFile());
    p.forceFail(HMS.PRINTER_FAULT);
    expect(p.buildReport().print.hms).toEqual([{ attr: 0, code: HMS.PRINTER_FAULT }]);

    p.reset();
    const report = p.buildReport();
    expect(report.print.gcode_state).toBe("IDLE");
    expect(report.print.hms).toEqual([]);
  });
});
