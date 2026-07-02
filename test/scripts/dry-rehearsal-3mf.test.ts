// Unit tests for the Stage-5 dry-rehearsal .gcode.3mf CLI's pure builder
// logic (scripts/dry-rehearsal-3mf.ts). Does NOT re-test buildDryRehearsalGcode
// itself (already covered by test/core/dry-gcode.test.ts) — this file only
// covers the CLI-specific layer: arg parsing, the A1-mini safety bounds, the
// final print-free guard, and the reported move-range stats.
import { describe, expect, test } from "bun:test";
import {
  DEFAULT_AMPLITUDE,
  DEFAULT_BOUNDS,
  DEFAULT_FEEDRATE,
  DEFAULT_OUT,
  DEFAULT_SWEEP_MS,
  UnsafeGcodeError,
  buildArtifact,
  computeMoveRange,
  findUnsafeLines,
  parseArgs,
} from "../../scripts/dry-rehearsal-3mf.ts";

describe("parseArgs", () => {
  test("defaults when no flags given", () => {
    const opts = parseArgs([]);
    expect(opts).toEqual({
      out: DEFAULT_OUT,
      sweepDurationMs: DEFAULT_SWEEP_MS,
      feedrate: DEFAULT_FEEDRATE,
      danceAmplitudeMm: DEFAULT_AMPLITUDE,
    });
  });

  test("overrides via flags", () => {
    const opts = parseArgs([
      "--out",
      "./tmp/x.gcode.3mf",
      "--sweep-ms",
      "1234",
      "--feedrate",
      "1500",
      "--amplitude",
      "12",
      "--swap",
      "G1 Z180 F3000",
    ]);
    expect(opts).toEqual({
      out: "./tmp/x.gcode.3mf",
      sweepDurationMs: 1234,
      feedrate: 1500,
      danceAmplitudeMm: 12,
      swapSequence: "G1 Z180 F3000",
    });
  });

  test("rejects an unknown flag", () => {
    expect(() => parseArgs(["--bogus", "1"])).toThrow();
  });

  test("rejects a flag missing its value", () => {
    expect(() => parseArgs(["--out"])).toThrow();
  });
});

describe("DEFAULT_BOUNDS — A1 mini safety margin", () => {
  test("stays within the printer's 180x180x180mm nominal build volume", () => {
    for (const axis of [DEFAULT_BOUNDS.x, DEFAULT_BOUNDS.y, DEFAULT_BOUNDS.z]) {
      expect(axis.min).toBeGreaterThanOrEqual(0);
      expect(axis.max).toBeLessThanOrEqual(180);
      expect(axis.min).toBeLessThan(axis.max);
    }
  });

  test("applies a non-zero inset from every edge (conservative margin, not the raw volume)", () => {
    expect(DEFAULT_BOUNDS.x.min).toBeGreaterThan(0);
    expect(DEFAULT_BOUNDS.x.max).toBeLessThan(180);
    expect(DEFAULT_BOUNDS.y.min).toBeGreaterThan(0);
    expect(DEFAULT_BOUNDS.y.max).toBeLessThan(180);
    expect(DEFAULT_BOUNDS.z.max).toBeLessThan(180);
  });
});

describe("buildArtifact — trajectory stays clamped to DEFAULT_BOUNDS", () => {
  test("every reported move coordinate is within DEFAULT_BOUNDS (INV-DRY-04)", () => {
    const artifact = buildArtifact({
      out: DEFAULT_OUT,
      sweepDurationMs: 2000,
      feedrate: 3000,
      danceAmplitudeMm: 30,
    });
    expect(artifact.range).not.toBeNull();
    const { range, bounds } = artifact;
    expect(range!.x.min).toBeGreaterThanOrEqual(bounds.x.min);
    expect(range!.x.max).toBeLessThanOrEqual(bounds.x.max);
    expect(range!.y.min).toBeGreaterThanOrEqual(bounds.y.min);
    expect(range!.y.max).toBeLessThanOrEqual(bounds.y.max);
    expect(range!.z.min).toBeGreaterThanOrEqual(bounds.z.min);
    expect(range!.z.max).toBeLessThanOrEqual(bounds.z.max);
  });

  test("a swap block deliberately outside bounds (e.g. G1 Z180) does not throw the range out of clamp expectations", () => {
    // The swap block is exempt from the trajectory clamp (dry-rehearsal §9);
    // the reported range legitimately extends past DEFAULT_BOUNDS.z.max when
    // a swap snippet is supplied.
    const artifact = buildArtifact({
      out: DEFAULT_OUT,
      sweepDurationMs: 2000,
      feedrate: 3000,
      danceAmplitudeMm: 30,
      swapSequence: "G1 Z180 F3000",
    });
    expect(artifact.range!.z.max).toBe(180);
  });

  test("computeMoveRange returns null for gcode with no move coordinates", () => {
    expect(computeMoveRange("G28 ; home\nM84 ; disable motors\n")).toBeNull();
  });
});

describe("findUnsafeLines / buildArtifact guard (INV-DRY-01/02, final guard)", () => {
  test("findUnsafeLines flags heater commands", () => {
    expect(findUnsafeLines("G1 X10 F3000\nM104 S200\nM84")).toEqual(["M104 S200"]);
    expect(findUnsafeLines("M109 S200")).toHaveLength(1);
    expect(findUnsafeLines("M140 S60")).toHaveLength(1);
    expect(findUnsafeLines("M190 S60")).toHaveLength(1);
  });

  test("findUnsafeLines flags E-axis moves", () => {
    expect(findUnsafeLines("G1 X10 E5 F3000")).toEqual(["G1 X10 E5 F3000"]);
  });

  test("findUnsafeLines ignores heater/E-like text inside comments", () => {
    expect(findUnsafeLines("G1 X10 F3000 ; not M104 or E5, just a comment")).toEqual([]);
  });

  test("findUnsafeLines returns [] for a clean trajectory", () => {
    expect(findUnsafeLines("G28\nG90\nG1 X10 Y10 F3000\nM84")).toEqual([]);
  });

  test("buildArtifact throws UnsafeGcodeError when the swap snippet heats", () => {
    expect(() =>
      buildArtifact({
        out: DEFAULT_OUT,
        sweepDurationMs: 500,
        feedrate: 3000,
        danceAmplitudeMm: 10,
        swapSequence: "M109 S220\nG1 Z180 F3000",
      }),
    ).toThrow(UnsafeGcodeError);
  });

  test("buildArtifact throws UnsafeGcodeError when the swap snippet extrudes", () => {
    expect(() =>
      buildArtifact({
        out: DEFAULT_OUT,
        sweepDurationMs: 500,
        feedrate: 3000,
        danceAmplitudeMm: 10,
        swapSequence: "G1 E5 F300",
      }),
    ).toThrow(UnsafeGcodeError);
  });

  test("buildArtifact succeeds for a clean swap snippet and reports an md5", () => {
    const artifact = buildArtifact({
      out: DEFAULT_OUT,
      sweepDurationMs: 500,
      feedrate: 3000,
      danceAmplitudeMm: 10,
      swapSequence: "G1 Z180 F3000",
    });
    expect(artifact.md5).toMatch(/^[0-9a-f]{32}$/);
    expect(artifact.gcode).toContain("DRY_SWAP_BEGIN");
  });
});
