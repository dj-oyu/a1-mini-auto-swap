// Dry-rehearsal G-code generator (dry-rehearsal-gcode-spec.md). Programmatically
// builds a print-free motion test — per-axis sweeps + figure-8 "dances" over 3
// layers (X/Y/Z) — to exercise the mechanism's vibration tolerance without
// filament or heat. Pure string building; delivery (gcode_line/file) and
// visualization are separate adapters.
//
// Optionally the plate-swap sequence is appended at the very end (§9): the test
// trajectory itself carries NO swap gcode, but running the rehearsal ends with a
// real plate swap — so the swap-gcode *insertion* is exercised too (same append
// mechanism as the print pipeline's injectEndSequence). The swap block is marked
// with ; DRY_SWAP_BEGIN/END and is exempt from the build-volume clamp (the swap
// intentionally moves the head out of the normal area, e.g. G1 Z180).

import { resolvePlaceholders } from "./gcode-inject.ts";

export const DRY_SWAP_BEGIN = "; DRY_SWAP_BEGIN 1";
export const DRY_SWAP_END = "; DRY_SWAP_END 1";

export interface Axis {
  min: number;
  max: number;
}
export interface Bounds3D {
  x: Axis;
  y: Axis;
  z: Axis;
}

export interface DryRehearsalOptions {
  sweepDurationMs: number;
  feedrate: number; // mm/min
  danceAmplitudeMm: number;
  danceSegments?: number; // discretization of the figure-8, default 48
  /** Server-side swap-sequence snippet (spec 7). When set, it is appended at the
   *  very end so the rehearsal triggers a real plate swap (§9). */
  swapSequence?: string;
  /** Optional header vars to resolve `{name}` placeholders in the swap snippet. */
  swapVars?: Record<string, string>;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Single-axis reciprocating sweep, clamped to the axis' safe range (§4.1/§5). */
export function axisSweep(
  axis: "X" | "Y" | "Z",
  durationMs: number,
  amplitudeMm: number,
  feedrate: number,
  bounds: Axis,
): string {
  const center = (bounds.min + bounds.max) / 2;
  const lo = clamp(center - amplitudeMm / 2, bounds.min, bounds.max);
  const hi = clamp(center + amplitudeMm / 2, bounds.min, bounds.max);
  const moveTimeMs = feedrate > 0 ? (Math.abs(hi - lo) / feedrate) * 60_000 : 0;
  const reps = moveTimeMs > 0 ? Math.max(1, Math.ceil(durationMs / (moveTimeMs * 2))) : 1;
  const lines: string[] = [];
  for (let i = 0; i < reps; i++) {
    lines.push(`G1 ${axis}${hi.toFixed(2)} F${feedrate}`);
    lines.push(`G1 ${axis}${lo.toFixed(2)} F${feedrate}`);
  }
  return lines.join("\n");
}

/** Figure-8 (Gerono lemniscate) flourish (§4.2). Every emitted coordinate is
 *  clamped into the safe build volume — the spec's §5 safety requirement. */
export function figureEightDance(
  centerX: number,
  centerY: number,
  z: number,
  amplitudeMm: number,
  feedrate: number,
  bounds: Bounds3D,
  segments = 48,
): string {
  const zc = clamp(z, bounds.z.min, bounds.z.max);
  const lines: string[] = [];
  for (let i = 0; i <= segments; i++) {
    const t = (i / segments) * 2 * Math.PI;
    const x = clamp(centerX + amplitudeMm * Math.sin(t), bounds.x.min, bounds.x.max);
    const y = clamp(centerY + amplitudeMm * Math.sin(t) * Math.cos(t), bounds.y.min, bounds.y.max);
    lines.push(`G1 X${x.toFixed(2)} Y${y.toFixed(2)} Z${zc.toFixed(2)} F${feedrate}`);
  }
  return lines.join("\n");
}

/** One axis layer: LAYER_CHANGE markers + that axis' sweep + a figure-8 (§3). */
export function buildAxisLayer(
  axis: "X" | "Y" | "Z",
  layerIndex: number,
  bounds: Bounds3D,
  opts: DryRehearsalOptions,
): string {
  const centerX = (bounds.x.min + bounds.x.max) / 2;
  const centerY = (bounds.y.min + bounds.y.max) / 2;
  const axisBounds = axis === "X" ? bounds.x : axis === "Y" ? bounds.y : bounds.z;
  const danceZ = axis === "Z" ? bounds.z.max * 0.5 : bounds.z.min + 10; // §8 暫定, §10 要検証
  const sweepAmp = Math.min(50, axisBounds.max - axisBounds.min);
  return [
    ";LAYER_CHANGE",
    `;Z:${layerIndex}`,
    ";HEIGHT:1",
    axisSweep(axis, opts.sweepDurationMs, sweepAmp, opts.feedrate, axisBounds),
    figureEightDance(centerX, centerY, danceZ, opts.danceAmplitudeMm, opts.feedrate, bounds, opts.danceSegments),
  ].join("\n");
}

/**
 * Full dry-rehearsal program: home first (§5 — never move absolute unhomed),
 * three axis layers (X/Y/Z), motors off at the end. Contains NO heater command
 * and NO extrusion (§5), and every coordinate is within `bounds`.
 */
export function buildDryRehearsalGcode(bounds: Bounds3D, opts: DryRehearsalOptions): string {
  const lines: string[] = ["G28 ; home all axes", "G90 ; absolute positioning"];
  (["X", "Y", "Z"] as const).forEach((axis, i) => {
    lines.push(buildAxisLayer(axis, i + 1, bounds, opts));
  });
  // §9: append the swap sequence at the very end (after the motion test), so a
  // real plate swap happens. The trajectory layers above contain no swap gcode.
  if (opts.swapSequence) {
    const snippet = opts.swapVars
      ? resolvePlaceholders(opts.swapSequence, opts.swapVars).text
      : opts.swapSequence;
    lines.push(DRY_SWAP_BEGIN, snippet.trim(), DRY_SWAP_END);
  }
  lines.push("M84 ; disable motors");
  return lines.join("\n") + "\n";
}
