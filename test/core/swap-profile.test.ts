import { readFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";
import { buildDryRehearsalGcode, DRY_SWAP_BEGIN, DRY_SWAP_END, type Bounds3D } from "../../src/core/dry-gcode.ts";
import { findUnsafeLines } from "../../scripts/dry-rehearsal-3mf.ts";

// The real swap sequence (Niiさん自動ビルドプレート交換mod, MakerWorld #925870), taken from the
// repo-managed profile that src/main.ts loads by default (spec 7). These tests exercise the
// real bytes on disk — not a synthetic stand-in — so a typo/format change in the profile file
// itself is caught, on top of the synthetic-snippet coverage already in dry-gcode.test.ts.

const PROFILE_PATH = "profiles/swap-sequence.gcode";
const PROFILE_TEXT = readFileSync(PROFILE_PATH, "utf8");

const BOUNDS: Bounds3D = { x: { min: 0, max: 180 }, y: { min: 0, max: 180 }, z: { min: 0, max: 180 } };
const OPTS = { sweepDurationMs: 2000, feedrate: 6000, danceAmplitudeMm: 30, danceSegments: 24 };

describe("profiles/swap-sequence.gcode — the real Niiさん mod sequence on disk", () => {
  test("the file exists and is non-empty", () => {
    expect(PROFILE_TEXT.trim().length).toBeGreaterThan(0);
  });

  test("contains the real G1 move lines, verbatim coordinates/feedrates unchanged", () => {
    const expectedMoves = [
      "G1 Z180 F3000",
      "G1 Y186 F6000",
      "G1 Z185 F3000",
      "G1 Y-4  F6000",
      "G1 Y186 F6000",
      "G1 Y-4  F6000",
      "G1 Y2.5 F6000",
      "G1 Y-4  F6000",
    ];
    for (const line of expectedMoves) expect(PROFILE_TEXT).toContain(line);
  });

  test("passes the print-free guard (no heater command, no E-axis move — INV-DRY-01/02)", () => {
    expect(findUnsafeLines(PROFILE_TEXT)).toEqual([]);
  });
});

describe("buildDryRehearsalGcode + the real swap profile (dry-rehearsal §9, INV-DRY-07)", () => {
  const withSwap = buildDryRehearsalGcode(BOUNDS, { ...OPTS, swapSequence: PROFILE_TEXT });
  const lines = withSwap.split("\n");

  test("DRY_SWAP_BEGIN/END appear exactly once each", () => {
    expect(withSwap.match(new RegExp(DRY_SWAP_BEGIN.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"))).toHaveLength(1);
    expect(withSwap.match(new RegExp(DRY_SWAP_END.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"))).toHaveLength(1);
  });

  test("the swap block sits after the last ;LAYER_CHANGE and before M84", () => {
    const lastLayer = lines.lastIndexOf(";LAYER_CHANGE");
    const swapBegin = lines.findIndex((l) => l.startsWith(DRY_SWAP_BEGIN));
    const swapEnd = lines.findIndex((l) => l.startsWith(DRY_SWAP_END));
    const m84 = lines.findIndex((l) => l.startsWith("M84"));
    expect(lastLayer).toBeGreaterThanOrEqual(0);
    expect(swapBegin).toBeGreaterThan(lastLayer);
    expect(swapEnd).toBeGreaterThan(swapBegin);
    expect(swapEnd).toBeLessThan(m84);
  });

  test("the real overtravel coordinates (Z185/Y186/Y-4) are emitted verbatim, unclamped", () => {
    expect(withSwap).toContain("G1 Z185 F3000");
    expect(withSwap).toContain("G1 Y186 F6000");
    expect(withSwap).toContain("G1 Y-4  F6000");
  });

  test("the pre-swap trajectory stays within bounds and carries no swap gcode", () => {
    const trajectory = withSwap.slice(0, withSwap.indexOf(DRY_SWAP_BEGIN));
    expect(trajectory).not.toContain("Z185");
    expect(trajectory).not.toContain("Y186");
  });

  test("the whole program (trajectory + real swap block) is still print-free (INV-DRY-01/02)", () => {
    expect(findUnsafeLines(withSwap)).toEqual([]);
  });

  test("without swapSequence, the real profile is never emitted (no accidental bake-in)", () => {
    const noSwap = buildDryRehearsalGcode(BOUNDS, OPTS);
    expect(noSwap).not.toContain(DRY_SWAP_BEGIN);
    expect(noSwap).not.toContain("Z185");
  });
});
