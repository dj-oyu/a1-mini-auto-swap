import { describe, expect, test } from "bun:test";
import { strToU8, zipSync } from "fflate";
import { extractPlateMesh } from "../../src/injection/threemf-mesh.ts";

// Integration: stage-3 `paint_color` wiring in extractPlateMesh. A synthetic
// production-extension .3mf where one object's single triangle is painted with a
// 3-split (four coloured sub-triangles). Asserts the plate mesh now carries a
// per-triangle `triExtruder` with MULTIPLE filament states, and that an
// unpainted archive stays byte-identical to stage 2 (no triExtruder).

/** External part with one triangle; `paint` (optional) is its paint_color hex. */
function part(objectId: number, verts: [number, number, number][], paint?: string): string {
  const v = verts.map(([x, y, z]) => `<vertex x="${x}" y="${y}" z="${z}"/>`).join("");
  const attr = paint ? ` paint_color="${paint}"` : "";
  return `<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">
 <resources>
  <object id="${objectId}" type="model">
   <mesh>
    <vertices>${v}</vertices>
    <triangles><triangle v1="0" v2="1" v3="2"${attr}/></triangles>
   </mesh>
  </object>
 </resources>
 <build/>
</model>`;
}

const ROOT = `<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" xmlns:p="http://schemas.microsoft.com/3dmanufacturing/production/2015/06">
 <resources>
  <object id="2" type="model"><components>
   <component p:path="/3D/Objects/object_1.model" objectid="1" transform="1 0 0 0 1 0 0 0 1 0 0 0"/>
  </components></object>
 </resources>
 <build><item objectid="2" transform="1 0 0 0 1 0 0 0 1 0 0 0"/></build>
</model>`;

const SETTINGS = `<config>
  <object id="2"><metadata key="extruder" value="3"/></object>
  <plate><metadata key="plater_id" value="1"/><model_instance><metadata key="object_id" value="2"/></model_instance></plate>
</config>`;

const PROJECT = JSON.stringify({ filament_colour: ["#111111", "#222222", "#333333"] });

function fixture(paint?: string, withProject = true): Buffer {
  const files: Record<string, Uint8Array> = {
    "3D/3dmodel.model": strToU8(ROOT),
    "3D/Objects/object_1.model": strToU8(part(1, [[0, 0, 0], [2, 0, 0], [0, 2, 0]], paint)),
    "Metadata/model_settings.config": strToU8(SETTINGS),
  };
  if (withProject) files["Metadata/project_settings.config"] = strToU8(PROJECT);
  return Buffer.from(zipSync(files));
}

describe("extractPlateMesh — stage 3 paint_color", () => {
  test("a painted triangle expands into coloured sub-triangles with per-triangle filaments", () => {
    // "84843" = 3-split, four leaves states [1,2,1,2].
    const mesh = extractPlateMesh(fixture("84843"), "plate_1")!;
    expect(mesh).not.toBeNull();
    // 1 source triangle → 4 sub-triangles = 4 output triangles = 12 index entries.
    expect(mesh.indices.length).toBe(12);
    // 3 (now-orphaned) original corners + 4 sub-triangles × 3 fresh verts = 15 verts.
    expect(mesh.positions.length).toBe(45);
    expect(mesh.triExtruder).toBeDefined();
    expect(mesh.triExtruder!.length).toBe(mesh.indices.length / 3); // 1:1 with triangles
    expect(mesh.triExtruder).toEqual([1, 2, 1, 2]);
    // MULTIPLE distinct filament states (not just the object's base extruder 3).
    expect(new Set(mesh.triExtruder)).toEqual(new Set([1, 2]));
    expect(mesh.filamentColours).toEqual(["#111111", "#222222", "#333333"]);
  });

  test("state 0 in a painted string resolves to the object's base extruder", () => {
    // one-level 1-split, child1 state 2 (8), child0 state 0 (0) → base extruder 3.
    // consumption [1,8,0] ⇒ reversed "081".
    const mesh = extractPlateMesh(fixture("081"), "plate_1")!;
    expect(mesh.triExtruder).toEqual([2, 3]); // child1=filament2, child0=state0→base 3
  });

  test("an UNPAINTED archive is identical to stage 2 (no triExtruder, no extra cost)", () => {
    const mesh = extractPlateMesh(fixture(undefined), "plate_1")!;
    expect(mesh.triExtruder).toBeUndefined();
    expect(mesh.indices).toEqual([0, 1, 2]); // single indexed triangle, unchanged
    expect(mesh.positions.length).toBe(9);
    expect(mesh.groups).toEqual([{ objectId: 2, extruder: 3, start: 0, count: 3 }]);
  });

  test("painted triangle-count grows by a bounded factor over the source triangle", () => {
    const painted = extractPlateMesh(fixture("84843"), "plate_1")!;
    const plain = extractPlateMesh(fixture(undefined), "plate_1")!;
    const growth = painted.indices.length / plain.indices.length;
    expect(growth).toBe(4); // 3-split = 4 sub-triangles per source triangle
    expect(growth).toBeLessThanOrEqual(4 ** 4); // never exceeds the depth cap bound
  });
});
