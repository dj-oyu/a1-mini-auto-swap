// Shared gcode -> .gcode.3mf packager (INV-INJECT-01). Extracted out of
// eject-threemf.ts so the dry-rehearsal CLI (scripts/dry-rehearsal-3mf.ts) can
// reuse the exact same, deterministic packaging logic.
import { describe, expect, test } from "bun:test";
import { strFromU8, unzipSync } from "fflate";
import { packageGcodeThreemf } from "../../src/injection/gcode-threemf.ts";
import { gcodeMd5 } from "../../src/injection/md5.ts";

const GCODE = "G28 ; home all axes\nG90 ; absolute positioning\nG1 X10 F3000\nM84 ; disable motors\n";

describe("packageGcodeThreemf", () => {
  test("packages Metadata/plate_1.gcode with a matching .md5 sidecar (INV-INJECT-01)", () => {
    const bytes = packageGcodeThreemf(GCODE);
    const files = unzipSync(new Uint8Array(bytes));
    const gcodeEntry = files["Metadata/plate_1.gcode"];
    const md5Entry = files["Metadata/plate_1.gcode.md5"];
    expect(gcodeEntry).toBeDefined();
    expect(md5Entry).toBeDefined();
    const gcode = strFromU8(gcodeEntry!);
    expect(gcode).toBe(GCODE);
    expect(strFromU8(md5Entry!).trim()).toBe(gcodeMd5(gcode));
  });

  test("output is deterministic for the same gcode (byte-identical)", () => {
    const a = packageGcodeThreemf(GCODE);
    const b = packageGcodeThreemf(GCODE);
    expect(a.equals(b)).toBe(true);
  });

  test("different gcode produces different bytes (sidecar tracks its own gcode)", () => {
    const a = packageGcodeThreemf(GCODE);
    const b = packageGcodeThreemf(GCODE + "; extra\n");
    expect(a.equals(b)).toBe(false);
  });
});
