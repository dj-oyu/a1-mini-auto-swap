import { buildEjectGcode } from "../core/eject-gcode.ts";
import { packageGcodeThreemf } from "./gcode-threemf.ts";

/**
 * Package the eject program (core/eject-gcode.ts) into a minimal `.gcode.3mf`:
 * `Metadata/plate_1.gcode` + its MD5 sidecar (the firmware verifies gcode
 * integrity against it — INV-INJECT-01, same rule as the injection pipeline).
 *
 * NOTE(spec 19 open item): whether the real A1 firmware accepts an archive
 * this minimal (no [Content_Types].xml / 3D model part) is a Phase 8
 * verification item. The stub's FTPS+project_file path accepts it; if the
 * real machine rejects it, extend this packager rather than the callers.
 *
 * Deterministic output: the zip entries use a fixed mtime so the same snippet
 * always produces byte-identical bytes (repo決定論ルール). Packaging itself
 * lives in gcode-threemf.ts (shared with the dry-rehearsal 3mf CLI).
 */
export function buildEjectThreemf(swapSequence: string, vars: Record<string, string> = {}): Buffer {
  const gcode = buildEjectGcode(swapSequence, vars);
  return packageGcodeThreemf(gcode);
}
