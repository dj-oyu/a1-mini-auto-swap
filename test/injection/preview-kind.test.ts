import { describe, expect, test } from "bun:test";
import { strToU8, zipSync } from "fflate";
import { previewKind } from "../../src/injection/threemf.ts";

// previewKind picks the read-only 3D preview renderer for a cached archive
// (Part A 3-tier). "printable"/slice-state is the same signal (findPlateGcodes
// > 0). Tiny synthetic fixtures — the giant real samples are never committed.

const PLATE_GCODE = "; HEADER_BLOCK_START\n; name = plate_1\n; HEADER_BLOCK_END\nG28\n";

/** A PROJECT 3mf: model_settings plater_id plates, NO plate_N.gcode, no mesh. */
function projectThreemf(platerIds: number[]): Buffer {
  const plates = platerIds
    .map((n) => `<plate><metadata key="plater_id" value="${n}"/></plate>`)
    .join("");
  return Buffer.from(
    zipSync({
      "3D/3dmodel.model": strToU8("<model><resources/><build/></model>"),
      "Metadata/model_settings.config": strToU8(`<?xml version="1.0"?><config>${plates}</config>`),
      "Metadata/project_settings.config": strToU8("{}"),
    }),
  );
}

/** A PROJECT 3mf whose geometry is an INLINE mesh in the root model. */
function inlineMeshThreemf(): Buffer {
  const model = `<model><resources><object id="1"><mesh>
    <vertices><vertex x="0" y="0" z="0"/><vertex x="1" y="0" z="0"/><vertex x="0" y="1" z="0"/></vertices>
    <triangles><triangle v1="0" v2="1" v3="2"/></triangles>
  </mesh></object></resources><build><item objectid="1"/></build></model>`;
  return Buffer.from(zipSync({ "3D/3dmodel.model": strToU8(model) }));
}

/** A PROJECT 3mf whose geometry lives in an external 3D/Objects/*.model part. */
function externalObjectsThreemf(): Buffer {
  return Buffer.from(
    zipSync({
      "3D/3dmodel.model": strToU8("<model><resources/><build/></model>"),
      "3D/Objects/object_1.model": strToU8("<model><resources><object id='1'/></resources></model>"),
    }),
  );
}

/** A sliced gcode.3mf: Metadata/plate_N.gcode entries, mesh stripped. */
function gcodeThreemf(plateNums: number[]): Buffer {
  const files: Record<string, Uint8Array> = { "Metadata/project_settings.config": strToU8("{}") };
  for (const n of plateNums) files[`Metadata/plate_${n}.gcode`] = strToU8(PLATE_GCODE);
  return Buffer.from(zipSync(files));
}

describe("previewKind (slice-state / 3-tier source selection)", () => {
  test("a sliced gcode.3mf (plate gcodes, no mesh) → 'gcode'", () => {
    expect(previewKind(gcodeThreemf([1]))).toBe("gcode");
    expect(previewKind(gcodeThreemf([1, 2, 24]))).toBe("gcode");
  });

  test("a PROJECT 3mf with model_settings plater_id plates (no gcode) → 'mesh'", () => {
    expect(previewKind(projectThreemf([1, 2]))).toBe("mesh");
  });

  test("a PROJECT 3mf with an INLINE root mesh → 'mesh'", () => {
    expect(previewKind(inlineMeshThreemf())).toBe("mesh");
  });

  test("a PROJECT 3mf with external 3D/Objects/*.model parts → 'mesh'", () => {
    expect(previewKind(externalObjectsThreemf())).toBe("mesh");
  });

  test("an archive with neither mesh nor gcode → 'thumb'", () => {
    const buf = Buffer.from(
      zipSync({
        "Metadata/project_settings.config": strToU8("{}"),
        "Metadata/plate_1.png": strToU8("not-really-a-png"),
      }),
    );
    expect(previewKind(buf)).toBe("thumb");
  });

  test("corrupt bytes degrade to 'thumb' (never throws)", () => {
    expect(previewKind(Buffer.from("not a zip"))).toBe("thumb");
  });

  test("a hybrid (inline mesh AND plate gcodes) prefers 'mesh' — real geometry wins", () => {
    const model = `<model><resources><object id="1"><mesh>
      <vertices><vertex x="0" y="0" z="0"/><vertex x="1" y="0" z="0"/><vertex x="0" y="1" z="0"/></vertices>
      <triangles><triangle v1="0" v2="1" v3="2"/></triangles>
    </mesh></object></resources><build><item objectid="1"/></build></model>`;
    const buf = Buffer.from(
      zipSync({
        "3D/3dmodel.model": strToU8(model),
        "Metadata/plate_1.gcode": strToU8(PLATE_GCODE),
      }),
    );
    expect(previewKind(buf)).toBe("mesh");
  });
});
