import { strToU8, zipSync } from "fflate";
import { buildEjectGcode } from "../core/eject-gcode.ts";
import { gcodeMd5 } from "./md5.ts";

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
 * always produces byte-identical bytes (repo決定論ルール).
 */
export function buildEjectThreemf(swapSequence: string, vars: Record<string, string> = {}): Buffer {
  const gcode = buildEjectGcode(swapSequence, vars);
  const md5 = gcodeMd5(gcode);
  const fixed = { mtime: new Date("2000-01-01T00:00:00Z") };
  const zipped = zipSync({
    "Metadata/plate_1.gcode": [strToU8(gcode), fixed],
    "Metadata/plate_1.gcode.md5": [strToU8(md5 + "\n"), fixed],
  });
  return Buffer.from(zipped);
}
