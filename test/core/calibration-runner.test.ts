import { describe, expect, test } from "bun:test";
import {
  CalibrationRunner,
  RunTimer,
  SWAP_DURATION_KEY,
  type CalibrationStore,
  type RunMeasurer,
} from "../../src/core/calibration.ts";
import type { Clock } from "../../src/core/ports.ts";

class FakeClock implements Clock {
  t = 0;
  now(): number {
    return this.t;
  }
}

class FakeStore implements CalibrationStore {
  m = new Map<string, string>();
  getSetting(k: string): string | null {
    return this.m.get(k) ?? null;
  }
  setSetting(k: string, v: string): void {
    this.m.set(k, v);
  }
}

/** Measurer that times each run with a real RunTimer over a fake clock,
 *  simulating base/swap durations from a per-iteration plan. `null` => the run
 *  fails (RUNNING→FAILED). */
class ScriptedMeasurer implements RunMeasurer {
  private call = 0;
  constructor(
    private readonly clock: FakeClock,
    private readonly plan: Array<{ base: number | null; swap: number | null }>,
  ) {}
  async measure(withSwap: boolean): Promise<number | null> {
    const iter = Math.floor(this.call / 2);
    this.call++;
    const dur = withSwap ? this.plan[iter]!.swap : this.plan[iter]!.base;
    const timer = new RunTimer(this.clock);
    this.clock.t += 100;
    timer.onState("RUNNING");
    if (dur == null) {
      this.clock.t += 50;
      timer.onState("FAILED");
      return null;
    }
    this.clock.t += dur;
    timer.onState("FINISH");
    return timer.durationMs();
  }
}

describe("CalibrationRunner — S10 differential calibration loop", () => {
  test("clean paired runs => swap_duration_ms persisted as the median difference", async () => {
    const clock = new FakeClock();
    const store = new FakeStore();
    const plan = Array.from({ length: 3 }, () => ({ base: 40_000, swap: 95_000 }));
    const result = await new CalibrationRunner(new ScriptedMeasurer(clock, plan), store).run(3);

    expect(result.samples).toEqual([55_000, 55_000, 55_000]);
    expect(result.updated).toBe(55_000);
    expect(store.getSetting(SWAP_DURATION_KEY)).toBe("55000");
  });

  test("an outlier iteration does not drag the estimate", async () => {
    const clock = new FakeClock();
    const store = new FakeStore();
    const plan = [
      { base: 40_000, swap: 95_000 },
      { base: 40_000, swap: 95_000 },
      { base: 40_000, swap: 600_000 }, // wild
    ];
    const result = await new CalibrationRunner(new ScriptedMeasurer(clock, plan), store).run(3);
    expect(result.updated).toBeGreaterThan(50_000);
    expect(result.updated).toBeLessThan(60_000);
  });

  test("a failed run in a pair is skipped, the rest still calibrate", async () => {
    const clock = new FakeClock();
    const store = new FakeStore();
    const plan = [
      { base: 40_000, swap: 95_000 },
      { base: 40_000, swap: null }, // this run fails -> pair dropped
      { base: 40_000, swap: 95_000 },
    ];
    const result = await new CalibrationRunner(new ScriptedMeasurer(clock, plan), store).run(3);
    expect(result.samples).toEqual([55_000, 55_000]);
    expect(store.getSetting(SWAP_DURATION_KEY)).toBe("55000");
  });

  test("no usable sample => existing swap_duration_ms is kept, not overwritten (INV-DRY-06)", async () => {
    const clock = new FakeClock();
    const store = new FakeStore();
    store.setSetting(SWAP_DURATION_KEY, "99999"); // pre-existing value
    const plan = [{ base: 40_000, swap: null }];
    const result = await new CalibrationRunner(new ScriptedMeasurer(clock, plan), store).run(1);

    expect(result.samples).toEqual([]);
    expect(result.updated).toBeNull();
    expect(store.getSetting(SWAP_DURATION_KEY)).toBe("99999"); // unchanged
  });
});
