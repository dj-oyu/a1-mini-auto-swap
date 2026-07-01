import { describe, expect, test } from "bun:test";
import {
  RunTimer,
  calibrateSwapDuration,
  median,
  swapSampleMs,
} from "../../src/core/calibration.ts";
import type { Clock } from "../../src/core/ports.ts";

class FakeClock implements Clock {
  t = 0;
  now(): number {
    return this.t;
  }
}

describe("median", () => {
  test("odd and even length", () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(median([])).toBe(0);
  });
});

describe("swapSampleMs (differential, §2)", () => {
  test("difference of with/without swap, floored at 0", () => {
    expect(swapSampleMs({ withSwapMs: 150_000, withoutSwapMs: 100_000 })).toBe(50_000);
    expect(swapSampleMs({ withSwapMs: 90_000, withoutSwapMs: 100_000 })).toBe(0); // noise => 0
  });
});

describe("calibrateSwapDuration (§6, INV-DRY-06)", () => {
  test("median of clean samples", () => {
    expect(calibrateSwapDuration([50_000, 52_000, 48_000, 51_000, 49_000])).toBe(50_000);
  });

  test("drops outliers before aggregating", () => {
    // one wild sample must not drag the estimate
    const r = calibrateSwapDuration([50_000, 50_000, 51_000, 49_000, 500_000]);
    expect(r).toBeGreaterThan(45_000);
    expect(r).toBeLessThan(55_000);
  });

  test("returns null when there is no usable sample (caller keeps old value)", () => {
    expect(calibrateSwapDuration([])).toBeNull();
    expect(calibrateSwapDuration([0, 0])).toBeNull();
    expect(calibrateSwapDuration([-5, -1])).toBeNull();
  });

  test("never returns a non-positive duration (INV-DRY-06)", () => {
    const r = calibrateSwapDuration([1, 1, 1]);
    expect(r).not.toBeNull();
    expect(r!).toBeGreaterThan(0);
  });
});

describe("RunTimer (Clock port)", () => {
  test("measures RUNNING->FINISH via the injected clock", () => {
    const clock = new FakeClock();
    const timer = new RunTimer(clock);
    clock.t = 1_000;
    timer.onState("RUNNING");
    clock.t = 1_090_000;
    timer.onState("FINISH");
    expect(timer.durationMs()).toBe(1_089_000);
  });

  test("ignores repeated RUNNING/FINISH (first RUNNING, first FINISH win)", () => {
    const clock = new FakeClock();
    const timer = new RunTimer(clock);
    clock.t = 100;
    timer.onState("RUNNING");
    clock.t = 200;
    timer.onState("RUNNING"); // ignored
    clock.t = 500;
    timer.onState("FINISH");
    clock.t = 900;
    timer.onState("FINISH"); // ignored
    expect(timer.durationMs()).toBe(400);
  });

  test("a FAILED run yields no duration", () => {
    const clock = new FakeClock();
    const timer = new RunTimer(clock);
    clock.t = 0;
    timer.onState("RUNNING");
    clock.t = 300;
    timer.onState("FAILED");
    expect(timer.durationMs()).toBeNull();
  });

  test("no FINISH yet => null", () => {
    const clock = new FakeClock();
    const timer = new RunTimer(clock);
    timer.onState("RUNNING");
    expect(timer.durationMs()).toBeNull();
  });

  test("end-to-end: two paired runs feed a calibration sample", () => {
    const clock = new FakeClock();
    // baseline (no swap): 40s
    const base = new RunTimer(clock);
    clock.t = 0;
    base.onState("RUNNING");
    clock.t = 40_000;
    base.onState("FINISH");
    // with swap: 95s
    const swap = new RunTimer(clock);
    clock.t = 100_000;
    swap.onState("RUNNING");
    clock.t = 195_000;
    swap.onState("FINISH");

    const sample = swapSampleMs({
      withSwapMs: swap.durationMs()!,
      withoutSwapMs: base.durationMs()!,
    });
    expect(sample).toBe(55_000);
    expect(calibrateSwapDuration([sample])).toBe(55_000);
  });
});
