import { describe, expect, test } from "bun:test";
import { strToU8, zipSync } from "fflate";
import { extractPlateMesh } from "../../src/injection/threemf-mesh.ts";

// Synthetic Bambu "production extension" .3mf: geometry lives in EXTERNAL part
// files (3D/Objects/object_N.model) referenced by <component p:path>, the scene
// is assembled by <build><item objectid=.. transform=..>, and the plate→object
// mapping lives in Metadata/model_settings.config. Fixtures are tiny + built
// in-test — the giant real samples are never committed.

/** A single-triangle external part file. */
function part(objectId: number, verts: [number, number, number][]): string {
  const v = verts.map(([x, y, z]) => `<vertex x="${x}" y="${y}" z="${z}"/>`).join("");
  return `<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">
 <resources>
  <object id="${objectId}" type="model">
   <mesh>
    <vertices>${v}</vertices>
    <triangles><triangle v1="0" v2="1" v3="2"/></triangles>
   </mesh>
  </object>
 </resources>
 <build/>
</model>`;
}

/** Root 3dmodel.model: two objects placed by two build items. object 2 is
 *  scaled ×2 + translated (10,20,30); object 4 is identity + translated. */
const ROOT = `<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" xmlns:p="http://schemas.microsoft.com/3dmanufacturing/production/2015/06" requiredextensions="p">
 <resources>
  <object id="2" type="model">
   <components>
    <component p:path="/3D/Objects/object_1.model" objectid="1" transform="1 0 0 0 1 0 0 0 1 0 0 0"/>
   </components>
  </object>
  <object id="4" type="model">
   <components>
    <component p:path="/3D/Objects/object_2.model" objectid="3" transform="1 0 0 0 1 0 0 0 1 0 0 0"/>
   </components>
  </object>
 </resources>
 <build>
  <item objectid="2" transform="2 0 0 0 2 0 0 0 2 10 20 30" printable="1"/>
  <item objectid="4" transform="1 0 0 0 1 0 0 0 1 100 0 0" printable="1"/>
 </build>
</model>`;

/** model_settings.config: plate 1 → object 2, plate 2 → object 4. */
const SETTINGS = `<?xml version="1.0" encoding="UTF-8"?>
<config>
  <object id="99"><metadata key="extruder" value="1"/></object>
  <plate>
    <metadata key="plater_id" value="1"/>
    <model_instance><metadata key="object_id" value="2"/><metadata key="instance_id" value="0"/></model_instance>
  </plate>
  <plate>
    <metadata key="plater_id" value="2"/>
    <model_instance><metadata key="object_id" value="4"/><metadata key="instance_id" value="0"/></model_instance>
  </plate>
</config>`;

function fixture(): Buffer {
  return Buffer.from(
    zipSync({
      "3D/3dmodel.model": strToU8(ROOT),
      // object 1: a triangle at unit coords → gets object-2 transform applied
      "3D/Objects/object_1.model": strToU8(
        part(1, [
          [1, 0, 0],
          [0, 1, 0],
          [0, 0, 1],
        ]),
      ),
      // object 3 (referenced by build object 4): a distinct triangle
      "3D/Objects/object_2.model": strToU8(
        part(3, [
          [0, 0, 0],
          [5, 0, 0],
          [0, 5, 0],
        ]),
      ),
      "Metadata/model_settings.config": strToU8(SETTINGS),
    }),
  );
}

describe("extractPlateMesh (task #23 — per-plate geometry)", () => {
  test("returns only the selected plate's object, with the build transform applied", () => {
    const mesh = extractPlateMesh(fixture(), "plate_1");
    expect(mesh).not.toBeNull();
    // one triangle → 3 vertices, 3 indices
    expect(mesh!.positions.length).toBe(9);
    expect(mesh!.indices).toEqual([0, 1, 2]);
    // (1,0,0) → ×2 + (10,20,30) = (12,20,30); (0,1,0) → (10,22,30); (0,0,1) → (10,20,32)
    expect(mesh!.positions).toEqual([12, 20, 30, 10, 22, 30, 10, 20, 32]);
  });

  test("a different plate id selects the other object (restriction works)", () => {
    const mesh = extractPlateMesh(fixture(), "plate_2");
    expect(mesh).not.toBeNull();
    // object 4: identity ×1 + translate (100,0,0): (0,0,0)→(100,0,0), (5,0,0)→(105,0,0), (0,5,0)→(100,5,0)
    expect(mesh!.positions).toEqual([100, 0, 0, 105, 0, 0, 100, 5, 0]);
  });

  test("computes a bbox over the transformed geometry", () => {
    const mesh = extractPlateMesh(fixture(), "plate_1")!;
    expect(mesh.bbox.min).toEqual([10, 20, 30]);
    expect(mesh.bbox.max).toEqual([12, 22, 32]);
  });

  test("exposes per-object groups as a coloring seam (extruder null for now)", () => {
    const mesh = extractPlateMesh(fixture(), "plate_1")!;
    expect(mesh.groups).toEqual([{ objectId: 2, extruder: null, start: 0, count: 3 }]);
  });

  test("bare numeric plate id also resolves the plate", () => {
    const mesh = extractPlateMesh(fixture(), "1")!;
    expect(mesh.positions).toEqual([12, 20, 30, 10, 22, 30, 10, 20, 32]);
  });

  test("component transform composes with the build-item transform", () => {
    // Root where the COMPONENT itself scales ×3, then the build item translates.
    const root = `<?xml version="1.0" encoding="UTF-8"?>
<model xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" xmlns:p="http://schemas.microsoft.com/3dmanufacturing/production/2015/06">
 <resources>
  <object id="2" type="model"><components>
   <component p:path="/3D/Objects/object_1.model" objectid="1" transform="3 0 0 0 3 0 0 0 3 0 0 0"/>
  </components></object>
 </resources>
 <build><item objectid="2" transform="1 0 0 0 1 0 0 0 1 1 2 3"/></build>
</model>`;
    const settings = `<config><plate><metadata key="plater_id" value="1"/><model_instance><metadata key="object_id" value="2"/></model_instance></plate></config>`;
    const buf = Buffer.from(
      zipSync({
        "3D/3dmodel.model": strToU8(root),
        "3D/Objects/object_1.model": strToU8(
          part(1, [
            [1, 1, 1],
            [2, 0, 0],
            [0, 2, 0],
          ]),
        ),
        "Metadata/model_settings.config": strToU8(settings),
      }),
    );
    const mesh = extractPlateMesh(buf, "plate_1")!;
    // (1,1,1) → ×3 = (3,3,3) → +(1,2,3) = (4,5,6)
    expect(mesh.positions.slice(0, 3)).toEqual([4, 5, 6]);
  });

  test("no plate config → falls back to the whole scene (all build items)", () => {
    const buf = Buffer.from(
      zipSync({
        "3D/3dmodel.model": strToU8(ROOT),
        "3D/Objects/object_1.model": strToU8(
          part(1, [
            [1, 0, 0],
            [0, 1, 0],
            [0, 0, 1],
          ]),
        ),
        "3D/Objects/object_2.model": strToU8(
          part(3, [
            [0, 0, 0],
            [5, 0, 0],
            [0, 5, 0],
          ]),
        ),
      }),
    );
    const mesh = extractPlateMesh(buf, "plate_1")!;
    // both objects rendered → 6 vertices, 2 triangles
    expect(mesh.positions.length).toBe(18);
    expect(mesh.indices).toEqual([0, 1, 2, 3, 4, 5]);
    expect(mesh.groups.map((g) => g.objectId)).toEqual([2, 4]);
  });

  test("single-plate export whose number doesn't match still renders (fallback)", () => {
    // model_settings has exactly one plate but it's plater_id 24 (kept original).
    const settings = `<config><plate><metadata key="plater_id" value="24"/><model_instance><metadata key="object_id" value="2"/></model_instance></plate></config>`;
    const buf = Buffer.from(
      zipSync({
        "3D/3dmodel.model": strToU8(ROOT),
        "3D/Objects/object_1.model": strToU8(
          part(1, [
            [1, 0, 0],
            [0, 1, 0],
            [0, 0, 1],
          ]),
        ),
        "Metadata/model_settings.config": strToU8(settings),
      }),
    );
    // ask for a mismatched id — single plate present → used anyway
    const mesh = extractPlateMesh(buf, "plate_999")!;
    expect(mesh.positions).toEqual([12, 20, 30, 10, 22, 30, 10, 20, 32]);
  });

  test("resolves external parts by p:path even when object ids COLLIDE across files", () => {
    // The whole reason this parser exists instead of a generic 3MF loader:
    // the production extension namespaces object ids per part file via p:path.
    // Both external files below declare <object id="1"> with DIFFERENT geometry.
    // A parser that flattens objects into one id-keyed map (the generic-loader
    // bug) would let one file's mesh overwrite the other's and both plates would
    // render the same geometry. We assert each plate resolves to ITS OWN file.
    const root = `<?xml version="1.0" encoding="UTF-8"?>
<model xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" xmlns:p="http://schemas.microsoft.com/3dmanufacturing/production/2015/06">
 <resources>
  <object id="2" type="model"><components>
   <component p:path="/3D/Objects/object_a.model" objectid="1" transform="1 0 0 0 1 0 0 0 1 0 0 0"/>
  </components></object>
  <object id="4" type="model"><components>
   <component p:path="/3D/Objects/object_b.model" objectid="1" transform="1 0 0 0 1 0 0 0 1 0 0 0"/>
  </components></object>
 </resources>
 <build>
  <item objectid="2" transform="1 0 0 0 1 0 0 0 1 0 0 0"/>
  <item objectid="4" transform="1 0 0 0 1 0 0 0 1 0 0 0"/>
 </build>
</model>`;
    const settings = `<config>
      <plate><metadata key="plater_id" value="1"/><model_instance><metadata key="object_id" value="2"/></model_instance></plate>
      <plate><metadata key="plater_id" value="2"/><model_instance><metadata key="object_id" value="4"/></model_instance></plate>
    </config>`;
    const buf = Buffer.from(
      zipSync({
        "3D/3dmodel.model": strToU8(root),
        // colliding id=1, but geometry A lives at z=1…
        "3D/Objects/object_a.model": strToU8(
          part(1, [
            [1, 0, 0],
            [0, 1, 0],
            [0, 0, 1],
          ]),
        ),
        // …and colliding id=1, geometry B lives at z=9 (clearly distinct)
        "3D/Objects/object_b.model": strToU8(
          part(1, [
            [9, 0, 0],
            [0, 9, 0],
            [0, 0, 9],
          ]),
        ),
        "Metadata/model_settings.config": strToU8(settings),
      }),
    );
    const a = extractPlateMesh(buf, "plate_1")!;
    const b = extractPlateMesh(buf, "plate_2")!;
    expect(a.positions).toEqual([1, 0, 0, 0, 1, 0, 0, 0, 1]); // object_a, not object_b
    expect(b.positions).toEqual([9, 0, 0, 0, 9, 0, 0, 0, 9]); // object_b, not object_a
  });

  test("returns null for an archive with no root model", () => {
    const buf = Buffer.from(zipSync({ "Metadata/project_settings.config": strToU8("{}") }));
    expect(extractPlateMesh(buf, "plate_1")).toBeNull();
  });

  test("returns null for non-zip bytes (never throws)", () => {
    expect(extractPlateMesh(Buffer.from("not a zip"), "plate_1")).toBeNull();
  });
});
