import { describe, expect, test } from "bun:test";
import {
  type Bounds3D,
  axisSweep,
  buildDryRehearsalGcode,
  figureEightDance,
} from "../../src/core/dry-gcode.ts";

const BOUNDS: Bounds3D = {
  x: { min: 0, max: 180 },
  y: { min: 0, max: 180 },
  z: { min: 0, max: 180 },
};
const OPTS = { sweepDurationMs: 2000, feedrate: 6000, danceAmplitudeMm: 30, danceSegments: 24 };

const gcode = buildDryRehearsalGcode(BOUNDS, OPTS);
const lines = gcode.split("\n");

/** Parse X/Y/Z/E words from all G1 lines. */
function coords(g: string) {
  const out: Array<{ axis: string; value: number }> = [];
  for (const line of g.split("\n")) {
    if (!line.startsWith("G1")) continue;
    for (const m of line.matchAll(/([XYZE])(-?\d+(?:\.\d+)?)/g)) {
      out.push({ axis: m[1]!, value: Number(m[2]) });
    }
  }
  return out;
}

describe("buildDryRehearsalGcode — safety (dry-rehearsal §5)", () => {
  test("contains no heater commands (INV-DRY-01)", () => {
    expect(gcode).not.toMatch(/\bM10[49]\b|\bM1[49]0\b/);
  });

  test("contains no extrusion (E) moves (INV-DRY-02)", () => {
    expect(coords(gcode).some((c) => c.axis === "E")).toBe(false);
  });

  test("homes (G28) before the first G1 (INV-DRY-03)", () => {
    const g28 = lines.findIndex((l) => l.startsWith("G28"));
    const firstG1 = lines.findIndex((l) => l.startsWith("G1"));
    expect(g28).toBeGreaterThanOrEqual(0);
    expect(g28).toBeLessThan(firstG1);
  });

  test("every coordinate stays within the safe bounds (INV-DRY-04)", () => {
    for (const c of coords(gcode)) {
      const b = c.axis === "X" ? BOUNDS.x : c.axis === "Y" ? BOUNDS.y : BOUNDS.z;
      expect(c.value).toBeGreaterThanOrEqual(b.min);
      expect(c.value).toBeLessThanOrEqual(b.max);
    }
  });

  test("ends with M84 motors-off (INV-DRY-06)", () => {
    expect(gcode.trimEnd().endsWith("M84 ; disable motors")).toBe(true);
  });
});

describe("buildDryRehearsalGcode — structure (dry-rehearsal §3)", () => {
  test("exactly 3 axis layers via LAYER_CHANGE markers (INV-DRY-05)", () => {
    expect(gcode.match(/;LAYER_CHANGE/g)).toHaveLength(3);
  });

  test("each axis is swept in its own layer", () => {
    // sweep lines are single-axis G1s; expect at least one X-only, Y-only, Z-only sweep
    const single = (axis: string) =>
      lines.some((l) => new RegExp(`^G1 ${axis}-?\\d`).test(l));
    expect(single("X")).toBe(true);
    expect(single("Y")).toBe(true);
    expect(single("Z")).toBe(true);
  });
});

describe("figure-8 clamping (dry-rehearsal §5)", () => {
  test("amplitude exceeding bounds is clamped, never emits out-of-range coords", () => {
    const g = figureEightDance(90, 90, 20, 500 /* huge */, 6000, BOUNDS, 32);
    for (const c of coords(g)) {
      const b = c.axis === "X" ? BOUNDS.x : c.axis === "Y" ? BOUNDS.y : BOUNDS.z;
      expect(c.value).toBeGreaterThanOrEqual(b.min);
      expect(c.value).toBeLessThanOrEqual(b.max);
    }
  });
});

describe("axisSweep", () => {
  test("reciprocates between clamped hi/lo and repeats to fill the duration", () => {
    const g = axisSweep("X", 2000, 40, 6000, { min: 0, max: 180 });
    const xs = coords(g).filter((c) => c.axis === "X").map((c) => c.value);
    expect(new Set(xs).size).toBe(2); // just hi and lo
    expect(Math.max(...xs)).toBeLessThanOrEqual(180);
    expect(Math.min(...xs)).toBeGreaterThanOrEqual(0);
    expect(xs.length).toBeGreaterThanOrEqual(2); // at least one round trip
  });
});
