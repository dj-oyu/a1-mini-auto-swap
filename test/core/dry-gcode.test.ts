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

describe("swap sequence appended at the end (dry-rehearsal §9, INV-DRY-07)", () => {
  const SWAP = "G1 Z250 F3000\nG1 X0 Y0\nM400"; // Z250 intentionally outside bounds
  const withSwap = buildDryRehearsalGcode(BOUNDS, { ...OPTS, swapSequence: SWAP });
  const wl = withSwap.split("\n");

  test("swap block appears exactly once, after the last layer and before M84", () => {
    expect(withSwap.match(/; DRY_SWAP_BEGIN/g)).toHaveLength(1);
    const lastLayer = wl.map((l) => l).lastIndexOf(";LAYER_CHANGE");
    const swapBegin = wl.findIndex((l) => l.startsWith("; DRY_SWAP_BEGIN"));
    const m84 = wl.findIndex((l) => l.startsWith("M84"));
    expect(swapBegin).toBeGreaterThan(lastLayer);
    expect(swapBegin).toBeLessThan(m84);
  });

  test("the trajectory (before the swap block) carries no swap gcode and stays in bounds (INV-DRY-04)", () => {
    const trajectory = withSwap.slice(0, withSwap.indexOf("; DRY_SWAP_BEGIN"));
    expect(trajectory).not.toContain("Z250"); // swap-only move is not in the trajectory
    for (const c of coords(trajectory)) {
      const b = c.axis === "X" ? BOUNDS.x : c.axis === "Y" ? BOUNDS.y : BOUNDS.z;
      expect(c.value).toBeGreaterThanOrEqual(b.min);
      expect(c.value).toBeLessThanOrEqual(b.max);
    }
  });

  test("the swap block is emitted verbatim (exempt from the bounds clamp)", () => {
    expect(withSwap).toContain("G1 Z250 F3000"); // NOT clamped to 180
  });

  test("still safe: no heater / no extrusion across the whole program (INV-DRY-01/02)", () => {
    expect(withSwap).not.toMatch(/\bM10[49]\b|\bM1[49]0\b/);
    expect(coords(withSwap).some((c) => c.axis === "E")).toBe(false);
  });

  test("resolves {name} placeholders in the swap snippet", () => {
    const g = buildDryRehearsalGcode(BOUNDS, {
      ...OPTS,
      swapSequence: "; swap for {name}\nM400",
      swapVars: { name: "plate_1" },
    });
    expect(g).toContain("; swap for plate_1");
    expect(g).not.toContain("{name}");
  });

  test("without swapSequence, no swap markers are emitted (backward compatible)", () => {
    expect(buildDryRehearsalGcode(BOUNDS, OPTS)).not.toContain("DRY_SWAP_BEGIN");
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
