import { describe, expect, test } from "bun:test";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { extractFilaments, injectIntoThreemf } from "../../src/injection/threemf.ts";
import { gcodeMd5 } from "../../src/injection/md5.ts";

const PLATE_GCODE = [
  "; HEADER_BLOCK_START",
  "; model_id = widget",
  "; name = plate_1",
  "; HEADER_BLOCK_END",
  "G28",
  "G1 X10 Y10",
  "M104 S0",
  "",
].join("\n");

const SETTINGS = JSON.stringify({
  filament_colour: ["#FF0000", "#0000FF"],
  filament_type: ["PLA", "PETG"],
});

function makeThreemf(): Buffer {
  return Buffer.from(
    zipSync({
      "Metadata/plate_1.gcode": strToU8(PLATE_GCODE),
      "Metadata/plate_1.gcode.md5": strToU8("stale-old-md5"),
      "Metadata/project_settings.config": strToU8(SETTINGS),
      "3D/3dmodel.model": strToU8("<model/>"),
    }),
  );
}

describe("extractFilaments (spec 5, INV-INJECT-06)", () => {
  test("re-reads filament colours/types from project_settings.config", () => {
    const fils = extractFilaments(makeThreemf());
    expect(fils).toEqual([
      { index: 0, color: "#FF0000", type: "PLA" },
      { index: 1, color: "#0000FF", type: "PETG" },
    ]);
  });
});

describe("injectIntoThreemf (spec 7)", () => {
  test("appends the snippet and recomputes the md5 sidecar to match (INV-INJECT-01/04)", () => {
    const result = injectIntoThreemf(makeThreemf(), { endSnippet: "G1 Z180 F3000\nM400" });
    const files = unzipSync(result.bytes);
    const newGcode = strFromU8(files["Metadata/plate_1.gcode"]!);
    const sidecar = strFromU8(files["Metadata/plate_1.gcode.md5"]!);

    expect(newGcode).toContain("G1 Z180 F3000"); // injected
    expect(newGcode.trimEnd().endsWith("M400")).toBe(true);
    expect(sidecar).not.toBe("stale-old-md5"); // recomputed
    expect(sidecar).toBe(gcodeMd5(newGcode)); // matches the NEW content (INV-INJECT-01)
    expect(result.md5).toBe(sidecar);
  });

  test("resolves {name} from the gcode header, no raw known placeholder remains (INV-INJECT-02)", () => {
    const result = injectIntoThreemf(makeThreemf(), { endSnippet: "; end of {name}\nM400" });
    const newGcode = strFromU8(unzipSync(result.bytes)["Metadata/plate_1.gcode"]!);
    expect(newGcode).toContain("; end of plate_1");
    expect(newGcode).not.toContain("{name}");
    expect(result.warnings).toHaveLength(0);
  });

  test("does not mutate the input archive (INV-INJECT-03)", () => {
    const input = makeThreemf();
    const snapshot = Buffer.from(input); // copy of the original bytes
    injectIntoThreemf(input, { endSnippet: "M400" });
    expect(input.equals(snapshot)).toBe(true); // input buffer untouched
    // and a fresh unzip of the original still has the pre-injection gcode + stale md5
    const files = unzipSync(input);
    expect(strFromU8(files["Metadata/plate_1.gcode"]!)).toBe(PLATE_GCODE);
    expect(strFromU8(files["Metadata/plate_1.gcode.md5"]!)).toBe("stale-old-md5");
  });

  test("throws when the requested plate is absent", () => {
    expect(() => injectIntoThreemf(makeThreemf(), { plate: "plate_9", endSnippet: "M400" })).toThrow(
      /not found/,
    );
  });
});
