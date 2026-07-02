import { describe, expect, test } from "bun:test";
import type { Clock } from "../../src/core/ports.ts";
import { StateLog, type ReportSource } from "../../src/orchestrator/state-log.ts";
import { createLogger } from "../../src/obs/logger.ts";
import { MemorySink } from "../../src/obs/sinks.ts";

const clock: Clock = { now: () => 1_700_000_000_000 };

class Emitter implements ReportSource {
  private listeners: Array<(raw: Record<string, unknown>) => void> = [];
  on(_e: "report", l: (raw: Record<string, unknown>) => void): this {
    this.listeners.push(l);
    return this;
  }
  off(_e: "report", l: (raw: Record<string, unknown>) => void): this {
    this.listeners = this.listeners.filter((x) => x !== l);
    return this;
  }
  emit(raw: Record<string, unknown>): void {
    for (const l of [...this.listeners]) l(raw);
  }
}

function harness() {
  const src = new Emitter();
  const mem = new MemorySink();
  const log = createLogger({ level: "debug", sinks: [mem], clock });
  const sl = new StateLog(src, log);
  sl.start();
  const changes = () => mem.records().filter((r) => r.event === "state_change");
  return { src, mem, sl, changes };
}

const amsRaw = (color: string, remain: number) => ({
  ams: { ams: [{ tray: [{ id: 0, tray_type: "PLA", tray_color: color, remain }] }] },
});

describe("StateLog", () => {
  test("emits a state_change on the first report", () => {
    const { src, changes } = harness();
    src.emit({ gcode_state: "RUNNING", print_error: 0, hms: [] });
    expect(changes()).toHaveLength(1);
    expect(changes()[0]!.from).toBe(null);
    expect(changes()[0]!.to).toBe("RUNNING");
  });

  test("suppresses reports with no meaningful change", () => {
    const { src, changes } = harness();
    src.emit({ gcode_state: "RUNNING", print_error: 0, hms: [] });
    src.emit({ gcode_state: "RUNNING", print_error: 0, hms: [] });
    expect(changes()).toHaveLength(1);
  });

  test("ignores mc_percent / remaining churn while state is unchanged", () => {
    const { src, changes } = harness();
    src.emit({ gcode_state: "RUNNING", print_error: 0, hms: [], mc_percent: 10, mc_remaining_time: 60 });
    src.emit({ gcode_state: "RUNNING", print_error: 0, hms: [], mc_percent: 55, mc_remaining_time: 30 });
    expect(changes()).toHaveLength(1);
  });

  test("logs the transition on a gcode_state change (from → to)", () => {
    const { src, changes } = harness();
    src.emit({ gcode_state: "RUNNING", print_error: 0, hms: [] });
    src.emit({ gcode_state: "PAUSE", print_error: 0, hms: [] });
    expect(changes()).toHaveLength(2);
    expect(changes()[1]!.from).toBe("RUNNING");
    expect(changes()[1]!.to).toBe("PAUSE");
  });

  test("captures a filament-runout pause: print_error + HMS, with hex renderings", () => {
    const { src, changes } = harness();
    src.emit({ gcode_state: "RUNNING", print_error: 0, hms: [] });
    src.emit({
      gcode_state: "PAUSE",
      print_error: 0x0500c010,
      hms: [{ code: 0x0300_0002 }],
    });
    const rec = changes()[1]!;
    expect(rec.to).toBe("PAUSE");
    expect(rec.print_error).toBe(0x0500c010);
    expect(rec.print_error_hex).toBe("0x0500C010");
    expect(rec.hms).toEqual([0x0300_0002]);
    expect(rec.hms_hex).toEqual(["0x03000002"]);
  });

  test("accepts print_error as a 0x string and normalizes to a number", () => {
    const { src, changes } = harness();
    src.emit({ gcode_state: "PAUSE", print_error: "0x0500C010", hms: [] });
    expect(changes()[0]!.print_error).toBe(0x0500c010);
  });

  test("emits when the AMS tray summary changes", () => {
    const { src, changes } = harness();
    src.emit({ gcode_state: "RUNNING", print_error: 0, hms: [], ...amsRaw("FF0000FF", 90) });
    src.emit({ gcode_state: "RUNNING", print_error: 0, hms: [], ...amsRaw("FF0000FF", 90) });
    expect(changes()).toHaveLength(1); // same AMS → suppressed
    src.emit({ gcode_state: "RUNNING", print_error: 0, hms: [], ...amsRaw("00FF00FF", 88) });
    expect(changes()).toHaveLength(2); // color+remain changed → emitted
    expect(changes()[1]!.ams).toEqual([{ slot: 0, type: "PLA", color: "00FF00FF", remain: 88 }]);
  });

  test("stop() unsubscribes so later reports are ignored", () => {
    const { src, sl, changes } = harness();
    src.emit({ gcode_state: "RUNNING", print_error: 0, hms: [] });
    sl.stop();
    src.emit({ gcode_state: "FINISH", print_error: 0, hms: [] });
    expect(changes()).toHaveLength(1);
  });
});
