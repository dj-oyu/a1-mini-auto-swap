import { describe, expect, test } from "bun:test";
import { strToU8, zipSync } from "fflate";
import { extractMesh } from "../../src/injection/threemf-mesh.ts";

// A single triangle (3 vertices) as a minimal 3MF model part.
const ONE_TRI = `<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter">
  <resources>
    <object id="1" type="model">
      <mesh>
        <vertices>
          <vertex x="0" y="0" z="0"/>
          <vertex x="10" y="0" z="0"/>
          <vertex x="0" y="10" z="0"/>
        </vertices>
        <triangles>
          <triangle v1="0" v2="1" v3="2"/>
        </triangles>
      </mesh>
    </object>
  </resources>
  <build><item objectid="1"/></build>
</model>`;

function threemf(model: string, path = "3D/3dmodel.model"): Buffer {
  return Buffer.from(zipSync({ [path]: strToU8(model) }));
}

describe("extractMesh", () => {
  test("parses vertices and triangles from 3D/3dmodel.model", () => {
    const mesh = extractMesh(threemf(ONE_TRI));
    expect(mesh).not.toBeNull();
    expect(mesh!.positions).toEqual([0, 0, 0, 10, 0, 0, 0, 10, 0]);
    expect(mesh!.indices).toEqual([0, 1, 2]);
  });

  test("merges multiple meshes and offsets indices per mesh", () => {
    const twoObjects = `<model><resources>
      <object id="1"><mesh>
        <vertices><vertex x="0" y="0" z="0"/><vertex x="1" y="0" z="0"/><vertex x="0" y="1" z="0"/></vertices>
        <triangles><triangle v1="0" v2="1" v3="2"/></triangles>
      </mesh></object>
      <object id="2"><mesh>
        <vertices><vertex x="0" y="0" z="5"/><vertex x="1" y="0" z="5"/><vertex x="0" y="1" z="5"/></vertices>
        <triangles><triangle v1="0" v2="1" v3="2"/></triangles>
      </mesh></object>
    </resources></model>`;
    const mesh = extractMesh(threemf(twoObjects))!;
    expect(mesh.positions.length).toBe(18); // 6 vertices * 3
    // second mesh's triangle indices are offset by the first mesh's 3 vertices
    expect(mesh.indices).toEqual([0, 1, 2, 3, 4, 5]);
  });

  test("also reads geometry from 3D/Objects/*.model parts", () => {
    const mesh = extractMesh(threemf(ONE_TRI, "3D/Objects/object_1.model"));
    expect(mesh).not.toBeNull();
    expect(mesh!.indices).toEqual([0, 1, 2]);
  });

  test("drops triangles whose indices exceed the mesh's vertex count", () => {
    const bad = `<model><resources><object id="1"><mesh>
      <vertices><vertex x="0" y="0" z="0"/><vertex x="1" y="0" z="0"/><vertex x="0" y="1" z="0"/></vertices>
      <triangles><triangle v1="0" v2="1" v3="2"/><triangle v1="0" v2="1" v3="9"/></triangles>
    </mesh></object></resources></model>`;
    const mesh = extractMesh(threemf(bad))!;
    expect(mesh.indices).toEqual([0, 1, 2]); // the out-of-range triangle is skipped
  });

  test("returns null when there is no geometry", () => {
    expect(extractMesh(threemf("<model><resources/></model>"))).toBeNull();
    expect(extractMesh(Buffer.from(zipSync({ "Metadata/x.txt": strToU8("hi") })))).toBeNull();
  });

  test("returns null on a corrupt archive instead of throwing", () => {
    expect(extractMesh(Buffer.from("not a zip"))).toBeNull();
  });
});
