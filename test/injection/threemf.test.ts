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

  // 実測 2026-07-02: a single letter sliced from a 26-plate project shipped only
  // Metadata/plate_24.gcode (all 26 PNGs, one gcode). Hardcoding plate_1 failed;
  // the plate gcode must be auto-discovered, and `param` must reflect it.
  test("auto-discovers the plate gcode when none is specified (not just plate_1)", () => {
    const threemf = Buffer.from(
      zipSync({
        "Metadata/plate_24.gcode": strToU8(PLATE_GCODE),
        "Metadata/plate_24.gcode.md5": strToU8("stale"),
        "Metadata/plate_1.png": strToU8("not gcode"), // thumbnails for other plates present
        "3D/3dmodel.model": strToU8("<model/>"),
      }),
    );
    const result = injectIntoThreemf(threemf, { endSnippet: "M400" });
    expect(result.param).toBe("Metadata/plate_24.gcode");
    const files = unzipSync(result.bytes);
    expect(strFromU8(files["Metadata/plate_24.gcode"]!)).toContain("M400");
    expect(strFromU8(files["Metadata/plate_24.gcode.md5"]!)).toBe(result.md5); // sidecar updated
  });

  test("param is the discovered plate path for a normal plate_1 archive", () => {
    expect(injectIntoThreemf(makeThreemf(), { endSnippet: "M400" }).param).toBe("Metadata/plate_1.gcode");
  });

  test("throws a clear error when the archive has no plate gcode at all", () => {
    const noGcode = Buffer.from(zipSync({ "3D/3dmodel.model": strToU8("<model/>") }));
    expect(() => injectIntoThreemf(noGcode, { endSnippet: "M400" })).toThrow(/no Metadata\/plate_N\.gcode/);
  });
});
