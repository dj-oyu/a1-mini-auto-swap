import { describe, expect, test } from "bun:test";
import { strToU8, zipSync } from "fflate";
import { extractMesh } from "../../src/injection/threemf-mesh.ts";

// Whole-archive preview (GET /api/queue/:id/model). Regression coverage for the
// origin-overlap bug: extractMesh MUST place each build item with its transform
// so multi-object Bambu files spread across their real plater positions instead
// of stacking every object at the origin. A count-only test let the bug through,
// so these assert COORDINATES / bbox separation.

/** A single-triangle external part (unit-ish coords near the local origin). */
function part(objectId: number): string {
  return `<model xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">
 <resources><object id="${objectId}" type="model"><mesh>
  <vertices><vertex x="0" y="0" z="0"/><vertex x="1" y="0" z="0"/><vertex x="0" y="1" z="0"/></vertices>
  <triangles><triangle v1="0" v2="1" v3="2"/></triangles>
 </mesh></object></resources></model>`;
}

/** Two build items translated to clearly different world x (+100 / -100). */
const ROOT_TWO = `<model xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" xmlns:p="http://schemas.microsoft.com/3dmanufacturing/production/2015/06" requiredextensions="p">
 <resources>
  <object id="2" type="model"><components><component p:path="/3D/Objects/object_1.model" objectid="1" transform="1 0 0 0 1 0 0 0 1 0 0 0"/></components></object>
  <object id="4" type="model"><components><component p:path="/3D/Objects/object_2.model" objectid="3" transform="1 0 0 0 1 0 0 0 1 0 0 0"/></components></object>
 </resources>
 <build>
  <item objectid="2" transform="1 0 0 0 1 0 0 0 1 100 0 0"/>
  <item objectid="4" transform="1 0 0 0 1 0 0 0 1 -100 0 0"/>
 </build>
</model>`;

function twoObjectArchive(): Buffer {
  return Buffer.from(
    zipSync({
      "3D/3dmodel.model": strToU8(ROOT_TWO),
      "3D/Objects/object_1.model": strToU8(part(1)),
      "3D/Objects/object_2.model": strToU8(part(3)),
    }),
  );
}

function xs(positions: number[]): number[] {
  const out: number[] = [];
  for (let i = 0; i < positions.length; i += 3) out.push(positions[i]!);
  return out;
}

describe("extractMesh — whole-archive scene (origin-overlap regression)", () => {
  test("places each build item at its world position — objects do NOT stack at the origin", () => {
    const mesh = extractMesh(twoObjectArchive())!;
    expect(mesh).not.toBeNull();
    // two triangles → 6 verts / 6 indices
    expect(mesh.positions.length).toBe(18);
    expect(mesh.indices).toEqual([0, 1, 2, 3, 4, 5]);

    const allX = xs(mesh.positions);
    // The bug piled every vertex near the origin (all x ≈ 0). Assert instead that
    // every vertex sits in one of the two translated clusters — nothing at origin.
    expect(allX.every((x) => x < -90 || x > 90)).toBe(true);
    const near100 = allX.filter((x) => x > 90);
    const nearNeg100 = allX.filter((x) => x < -90);
    expect(near100.length).toBe(3); // object at +100
    expect(nearNeg100.length).toBe(3); // object at -100

    // Disjoint bboxes: the +x object's whole range is right of the -x object's.
    expect(Math.min(...near100)).toBeGreaterThan(Math.max(...nearNeg100));
    // overall x spans both clusters
    expect(Math.min(...allX)).toBe(-100);
    expect(Math.max(...allX)).toBe(101);
  });

  test("the /model contract stays { positions, indices } only (no bbox/groups)", () => {
    const mesh = extractMesh(twoObjectArchive())!;
    expect(Object.keys(mesh).sort()).toEqual(["indices", "positions"]);
  });

  test("fallback: an archive with NO <build> still renders its inline mesh (untransformed)", () => {
    const inline = `<model xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">
 <resources><object id="1" type="model"><mesh>
  <vertices><vertex x="0" y="0" z="0"/><vertex x="2" y="0" z="0"/><vertex x="0" y="3" z="0"/></vertices>
  <triangles><triangle v1="0" v2="1" v3="2"/></triangles>
 </mesh></object></resources></model>`;
    const buf = Buffer.from(zipSync({ "3D/3dmodel.model": strToU8(inline) }));
    const mesh = extractMesh(buf)!;
    expect(mesh).not.toBeNull();
    // local coords, no transform to apply (no build)
    expect(mesh.positions).toEqual([0, 0, 0, 2, 0, 0, 0, 3, 0]);
    expect(mesh.indices).toEqual([0, 1, 2]);
  });

  test("returns null for non-zip bytes", () => {
    expect(extractMesh(Buffer.from("not a zip"))).toBeNull();
  });
});
