import { describe, expect, test } from "bun:test";
import { strToU8, zipSync } from "fflate";
import { listPreviewPlates } from "../../src/injection/threemf.ts";

// listPreviewPlates enumerates plates for the read-only 3D preview across ALL
// 3mf types: gcode plates when sliced (printable), else the model_settings
// plater_id plates of a PROJECT 3mf (preview-only). Tiny synthetic fixtures —
// the giant real samples are never committed.

const PLATE_GCODE = "; HEADER_BLOCK_START\n; name = plate_1\n; HEADER_BLOCK_END\nG28\n";

/** A project 3mf: model_settings <plate> plater_id entries, NO plate_N.gcode. */
function projectThreemf(platerIds: number[]): Buffer {
  const plates = platerIds
    .map(
      (n) =>
        `<plate><metadata key="plater_id" value="${n}"/><metadata key="plater_name" value=""/><model_instance><metadata key="object_id" value="${n * 2}"/></model_instance></plate>`,
    )
    .join("");
  return Buffer.from(
    zipSync({
      "3D/3dmodel.model": strToU8("<model><resources/></model>"),
      "Metadata/model_settings.config": strToU8(`<?xml version="1.0"?><config>${plates}</config>`),
    }),
  );
}

/** A sliced gcode.3mf: Metadata/plate_N.gcode entries. */
function gcodeThreemf(plateNums: number[]): Buffer {
  const files: Record<string, Uint8Array> = { "Metadata/project_settings.config": strToU8("{}") };
  for (const n of plateNums) files[`Metadata/plate_${n}.gcode`] = strToU8(PLATE_GCODE);
  return Buffer.from(zipSync(files));
}

describe("listPreviewPlates", () => {
  test("PROJECT 3mf (no gcode) enumerates its model_settings plater_id plates — preview-only", () => {
    const plates = listPreviewPlates(projectThreemf([1, 2]));
    expect(plates.map((p) => p.plate)).toEqual(["plate_1", "plate_2"]);
    expect(plates.every((p) => p.printable === false)).toBe(true);
    expect(plates.every((p) => p.estimatedSeconds === null)).toBe(true);
  });

  test("PROJECT 3mf plater_id plates are sorted and de-duplicated, keep original numbers", () => {
    const plates = listPreviewPlates(projectThreemf([24, 1, 24]));
    expect(plates.map((p) => p.plate)).toEqual(["plate_1", "plate_24"]);
  });

  test("gcode.3mf enumerates its gcode plates as PRINTABLE (gcode wins over model_settings)", () => {
    const plates = listPreviewPlates(gcodeThreemf([1, 2, 3]));
    expect(plates.map((p) => p.plate)).toEqual(["plate_1", "plate_2", "plate_3"]);
    expect(plates.every((p) => p.printable === true)).toBe(true);
  });

  test("single-plate file enumerates exactly one plate", () => {
    expect(listPreviewPlates(gcodeThreemf([7])).map((p) => p.plate)).toEqual(["plate_7"]);
    expect(listPreviewPlates(projectThreemf([3])).map((p) => p.plate)).toEqual(["plate_3"]);
  });

  test("an archive with neither gcode nor model_settings plates enumerates none", () => {
    const buf = Buffer.from(zipSync({ "Metadata/project_settings.config": strToU8("{}") }));
    expect(listPreviewPlates(buf)).toEqual([]);
  });
});
