// Eject-job .gcode.3mf packaging (spec 6/19). The archive must carry the
// gcode plus a correct MD5 sidecar — the firmware verifies gcode integrity
// against it (INV-INJECT-01), same rule as the injection pipeline.
import { describe, expect, test } from "bun:test";
import { strFromU8, unzipSync } from "fflate";
import { buildEjectThreemf } from "../../src/injection/eject-threemf.ts";
import { gcodeMd5 } from "../../src/injection/md5.ts";

const SWAP = "G1 Z180 F3000\nM400";

describe("buildEjectThreemf", () => {
  test("packages Metadata/plate_1.gcode with a matching .md5 sidecar (INV-INJECT-01)", () => {
    const bytes = buildEjectThreemf(SWAP);
    const files = unzipSync(new Uint8Array(bytes));
    const gcodeEntry = files["Metadata/plate_1.gcode"];
    const md5Entry = files["Metadata/plate_1.gcode.md5"];
    expect(gcodeEntry).toBeDefined();
    expect(md5Entry).toBeDefined();
    const gcode = strFromU8(gcodeEntry!);
    expect(strFromU8(md5Entry!).trim()).toBe(gcodeMd5(gcode));
    // the gcode inside is the eject program (home + swap + motors off)
    expect(gcode).toContain("G28");
    expect(gcode).toContain("G1 Z180 F3000");
    expect(gcode.trim().endsWith("M84 ; disable motors")).toBe(true);
  });

  test("output is deterministic for the same snippet (byte-identical)", () => {
    const a = buildEjectThreemf(SWAP);
    const b = buildEjectThreemf(SWAP);
    expect(a.equals(b)).toBe(true);
  });
});
