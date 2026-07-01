import { describe, expect, test } from "bun:test";
import { calcEta } from "../../src/orchestrator/eta.ts";

const NOW = 1_700_000_000_000;
const SWAP = 90_000; // 90s

describe("calcEta (spec ch10)", () => {
  test("queued-only: static estimates + one swap per boundary (INV-ETA-02)", () => {
    const r = calcEta({
      now: NOW,
      swapDurationMs: SWAP,
      queued: [
        { id: 1, estimatedSeconds: 600 }, // 10 min
        { id: 2, estimatedSeconds: 300 }, // 5 min
      ],
    });
    expect(r.plateEtas[1]).toBe(NOW + 600_000);
    expect(r.plateEtas[2]).toBe(NOW + 600_000 + SWAP + 300_000);
    expect(r.projectEta).toBe(NOW + 600_000 + SWAP + 300_000 + SWAP);
  });

  test("running job uses live mc_remaining_time (INV-ETA-01)", () => {
    const r = calcEta({
      now: NOW,
      swapDurationMs: SWAP,
      running: { id: 9, remainingMinutes: 4 },
      queued: [{ id: 1, estimatedSeconds: 120 }],
    });
    expect(r.plateEtas[9]).toBe(NOW + 4 * 60_000);
    expect(r.plateEtas[1]).toBe(NOW + 4 * 60_000 + SWAP + 120_000);
  });

  test("plateEtas are monotonic non-decreasing (INV-ETA-03)", () => {
    const r = calcEta({
      now: NOW,
      swapDurationMs: SWAP,
      running: { id: 9, remainingMinutes: 2 },
      queued: [
        { id: 1, estimatedSeconds: 60 },
        { id: 2, estimatedSeconds: 60 },
        { id: 3, estimatedSeconds: 60 },
      ],
    });
    const inOrder = [r.plateEtas[9]!, r.plateEtas[1]!, r.plateEtas[2]!, r.plateEtas[3]!];
    for (let i = 1; i < inOrder.length; i++) {
      expect(inOrder[i]!).toBeGreaterThanOrEqual(inOrder[i - 1]!);
    }
  });

  test("empty queue with no running job: projectEta == now", () => {
    expect(calcEta({ now: NOW, swapDurationMs: SWAP, queued: [] }).projectEta).toBe(NOW);
  });
});
