// CLI: build a real-hardware dry-rehearsal `.gcode.3mf` (dry-rehearsal-gcode-spec.md,
// Stage 5 of the real-hardware verification plan). Wraps
// core/dry-gcode.ts#buildDryRehearsalGcode with CLI arg parsing, an A1-mini
// safety-margin bounds default, and a final print-free guard (INV-DRY-01/02)
// before packaging into a `.gcode.3mf` via injection/gcode-threemf.ts.
//
// Usage:
//   bun run scripts/dry-rehearsal-3mf.ts [--out path] [--sweep-ms n]
//     [--feedrate n] [--amplitude n] [--swap "gcode snippet"]
//   bun run dry3mf -- [...same flags]

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { type Axis, type Bounds3D, buildDryRehearsalGcode } from "../src/core/dry-gcode.ts";
import { packageGcodeThreemf } from "../src/injection/gcode-threemf.ts";
import { gcodeMd5 } from "../src/injection/md5.ts";

export const DEFAULT_OUT = "./data/dry-rehearsal.gcode.3mf";
export const DEFAULT_SWEEP_MS = 5000;
export const DEFAULT_FEEDRATE = 3000;
export const DEFAULT_AMPLITUDE = 30;

/**
 * A1 mini's nominal build volume is 180x180x180mm (bed X/Y, gantry Z). The
 * exact frame/gantry clearance near the physical edges is unverified against
 * real hardware pre-Stage-5 (dry-rehearsal-gcode-spec.md §10 lists this as an
 * open item), so this CLI deliberately trades a bit of coverage for safety
 * margin beyond dry-gcode.ts's own per-move clamp (INV-DRY-04):
 *   - X/Y: 10mm inset from each edge (10..170) — keeps the nozzle/gantry off
 *     the frame and any edge-mounted hardware (e.g. the swap mechanism).
 *   - Z: 5mm off the bed (avoids a bed-strike from Z homing tolerance) and
 *     10mm below the top of the gantry travel (170 of 180) to avoid topping
 *     out against the frame/belt hardware at full extension.
 * These are intentionally conservative; loosen only after a supervised
 * Stage 5 run confirms real clearances.
 */
export const DEFAULT_BOUNDS: Bounds3D = {
  x: { min: 10, max: 170 },
  y: { min: 10, max: 170 },
  z: { min: 5, max: 170 },
};

export interface DryRehearsalCliOptions {
  out: string;
  sweepDurationMs: number;
  feedrate: number;
  danceAmplitudeMm: number;
  swapSequence?: string;
}

/** Thrown when the generated gcode fails the final print-free guard (INV-DRY-01/02). */
export class UnsafeGcodeError extends Error {}

export function parseArgs(argv: string[]): DryRehearsalCliOptions {
  const opts: DryRehearsalCliOptions = {
    out: DEFAULT_OUT,
    sweepDurationMs: DEFAULT_SWEEP_MS,
    feedrate: DEFAULT_FEEDRATE,
    danceAmplitudeMm: DEFAULT_AMPLITUDE,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const next = (): string => {
      i++;
      const v = argv[i];
      if (v === undefined) throw new Error(`${arg} requires a value`);
      return v;
    };
    switch (arg) {
      case "--out":
        opts.out = next();
        break;
      case "--sweep-ms":
        opts.sweepDurationMs = Number(next());
        break;
      case "--feedrate":
        opts.feedrate = Number(next());
        break;
      case "--amplitude":
        opts.danceAmplitudeMm = Number(next());
        break;
      case "--swap":
        opts.swapSequence = next();
        break;
      default:
        throw new Error(`unknown argument: ${arg}`);
    }
  }
  return opts;
}

/**
 * Final print-free guard (INV-DRY-01/02): scan every gcode line (comments
 * stripped) for a heater command or an E-axis word. This is the last line of
 * defense — it also covers a caller-supplied `--swap` snippet, which is
 * exempt from the build-volume clamp (dry-rehearsal §9) but must still never
 * heat or extrude.
 */
export function findUnsafeLines(gcode: string): string[] {
  const heaterRe = /\b(M104|M109|M140|M190)\b/i;
  const eAxisRe = /(^|\s)E-?[0-9]*\.?[0-9]+(\s|$)/;
  const violations: string[] = [];
  for (const rawLine of gcode.split("\n")) {
    const code = rawLine.split(";")[0]!;
    if (!code.trim()) continue;
    if (heaterRe.test(code) || eAxisRe.test(code)) violations.push(rawLine);
  }
  return violations;
}

function parseWord(codeLine: string, letter: string): number | null {
  const m = codeLine.match(new RegExp(`${letter}(-?[0-9]*\\.?[0-9]+)`));
  return m ? Number.parseFloat(m[1]!) : null;
}

/** Observed min/max X/Y/Z across every G0/G1 move in the gcode (includes the
 *  swap block, which is intentionally out of `bounds` — this is a report,
 *  not an enforcement check). Returns null if no move line has any coordinate. */
export function computeMoveRange(gcode: string): Bounds3D | null {
  let xr: Axis | null = null;
  let yr: Axis | null = null;
  let zr: Axis | null = null;
  const widen = (r: Axis | null, v: number | null): Axis | null => {
    if (v === null) return r;
    return r ? { min: Math.min(r.min, v), max: Math.max(r.max, v) } : { min: v, max: v };
  };
  for (const rawLine of gcode.split("\n")) {
    const code = rawLine.split(";")[0]!.trim();
    if (!/^G[01]\b/.test(code)) continue;
    xr = widen(xr, parseWord(code, "X"));
    yr = widen(yr, parseWord(code, "Y"));
    zr = widen(zr, parseWord(code, "Z"));
  }
  if (!xr && !yr && !zr) return null;
  return { x: xr ?? { min: 0, max: 0 }, y: yr ?? { min: 0, max: 0 }, z: zr ?? { min: 0, max: 0 } };
}

export interface DryRehearsalArtifact {
  gcode: string;
  bounds: Bounds3D;
  range: Bounds3D | null;
  md5: string;
}

/**
 * Pure build step (no I/O): generate the dry-rehearsal gcode via
 * core/dry-gcode.ts, run the final print-free guard, and compute reporting
 * stats. Throws `UnsafeGcodeError` if the guard fails — callers (the CLI
 * `main()`) must treat that as a hard refusal (exit 1), never write a file.
 */
export function buildArtifact(opts: DryRehearsalCliOptions): DryRehearsalArtifact {
  const gcode = buildDryRehearsalGcode(DEFAULT_BOUNDS, {
    sweepDurationMs: opts.sweepDurationMs,
    feedrate: opts.feedrate,
    danceAmplitudeMm: opts.danceAmplitudeMm,
    swapSequence: opts.swapSequence,
  });
  const violations = findUnsafeLines(gcode);
  if (violations.length > 0) {
    throw new UnsafeGcodeError(
      `refusing to generate dry-rehearsal gcode: found ${violations.length} unsafe line(s) ` +
        `(heater command or E-axis move, INV-DRY-01/02):\n${violations.join("\n")}`,
    );
  }
  return { gcode, bounds: DEFAULT_BOUNDS, range: computeMoveRange(gcode), md5: gcodeMd5(gcode) };
}

function fmtAxis(a: Axis): string {
  return `[${a.min.toFixed(2)}, ${a.max.toFixed(2)}]`;
}

function main(): void {
  const opts = parseArgs(process.argv.slice(2));
  let artifact: DryRehearsalArtifact;
  try {
    artifact = buildArtifact(opts);
  } catch (err) {
    if (err instanceof UnsafeGcodeError) {
      console.error(err.message);
      process.exit(1);
    }
    throw err;
  }

  const threemf = packageGcodeThreemf(artifact.gcode);
  const outPath = resolve(opts.out);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, threemf);

  console.log(`wrote ${outPath} (${threemf.length} bytes)`);
  console.log(`gcode md5: ${artifact.md5}`);
  if (artifact.range) {
    console.log(
      `move range: X${fmtAxis(artifact.range.x)} Y${fmtAxis(artifact.range.y)} Z${fmtAxis(artifact.range.z)} ` +
        `(bounds: X${fmtAxis(artifact.bounds.x)} Y${fmtAxis(artifact.bounds.y)} Z${fmtAxis(artifact.bounds.z)})`,
    );
  }
}

if (import.meta.main) {
  main();
}
