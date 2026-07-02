import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Clock } from "../../src/core/ports.ts";
import { ReportRecorder } from "../../src/orchestrator/report-recorder.ts";
import type { ReportSource } from "../../src/orchestrator/state-log.ts";

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

describe("ReportRecorder (raw firehose)", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "obs-rec-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("appends every report verbatim with a ts, to a date-stamped file", () => {
    const clock: Clock = { now: () => Date.parse("2026-07-03T09:00:00Z") };
    const src = new Emitter();
    const rec = new ReportRecorder(src, { dir, clock, retentionDays: 0 });
    rec.start();
    src.emit({ gcode_state: "RUNNING", mc_percent: 10 });
    src.emit({ gcode_state: "RUNNING", mc_percent: 11 });

    const file = join(dir, "2026-07-03.jsonl"); // empty prefix → just the date
    expect(existsSync(file)).toBe(true);
    const lines = readFileSync(file, "utf8").trim().split("\n");
    expect(lines).toHaveLength(2);
    const first = JSON.parse(lines[0]!) as Record<string, unknown>;
    expect(first.ts).toBe(Date.parse("2026-07-03T09:00:00Z"));
    expect(first.gcode_state).toBe("RUNNING");
    expect(first.mc_percent).toBe(10);
    // Unlike StateLog, no suppression: the second (only-percent-diff) report lands too.
    const second = JSON.parse(lines[1]!) as Record<string, unknown>;
    expect(second.mc_percent).toBe(11);
  });

  test("stop() unsubscribes so later reports are not recorded", () => {
    const clock: Clock = { now: () => Date.parse("2026-07-03T09:00:00Z") };
    const src = new Emitter();
    const rec = new ReportRecorder(src, { dir, clock, retentionDays: 0 });
    rec.start();
    src.emit({ gcode_state: "RUNNING" });
    rec.stop();
    src.emit({ gcode_state: "FINISH" });

    const lines = readFileSync(join(dir, "2026-07-03.jsonl"), "utf8").trim().split("\n");
    expect(lines).toHaveLength(1);
  });
});
