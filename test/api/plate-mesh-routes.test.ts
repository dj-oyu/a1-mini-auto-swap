import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Hono } from "hono";
import { strToU8, zipSync } from "fflate";
import { createModelApp } from "../../src/api/model-routes.ts";
import { openDb, type Db } from "../../src/db/index.ts";
import type { Repo } from "../../src/db/repo.ts";

const ROOT = `<model xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" xmlns:p="http://schemas.microsoft.com/3dmanufacturing/production/2015/06">
 <resources>
  <object id="2" type="model"><components>
   <component p:path="/3D/Objects/object_1.model" objectid="1" transform="1 0 0 0 1 0 0 0 1 0 0 0"/>
  </components></object>
 </resources>
 <build><item objectid="2" transform="1 0 0 0 1 0 0 0 1 0 0 0"/></build>
</model>`;
const PART = `<model xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">
 <resources><object id="1" type="model"><mesh>
  <vertices><vertex x="0" y="0" z="0"/><vertex x="1" y="0" z="0"/><vertex x="0" y="1" z="0"/></vertices>
  <triangles><triangle v1="0" v2="1" v3="2"/></triangles>
 </mesh></object></resources></model>`;
const SETTINGS = `<config><plate><metadata key="plater_id" value="1"/><model_instance><metadata key="object_id" value="2"/></model_instance></plate></config>`;

function threemf(): Buffer {
  return Buffer.from(
    zipSync({
      "3D/3dmodel.model": strToU8(ROOT),
      "3D/Objects/object_1.model": strToU8(PART),
      "Metadata/model_settings.config": strToU8(SETTINGS),
    }),
  );
}
function threemfNoMesh(): Buffer {
  return Buffer.from(zipSync({ "Metadata/project_settings.config": strToU8("{}") }));
}

let dbh: Db;
let repo: Repo;
let app: Hono;
let cacheDir: string;

beforeEach(() => {
  dbh = openDb(":memory:");
  repo = dbh.repo;
  cacheDir = mkdtempSync(join(tmpdir(), "plate-mesh-"));
  app = createModelApp({ repo, cacheDir });
});
afterEach(() => rmSync(cacheDir, { recursive: true, force: true }));

describe("GET /api/plate-mesh (task #23)", () => {
  test("returns the per-plate mesh JSON for a cached job", async () => {
    const id = repo.createJob({ filename: "p.3mf" });
    writeFileSync(join(cacheDir, `${id}.gcode.3mf`), threemf());

    const res = await app.request(`/api/plate-mesh?job=${id}&plate=plate_1`);
    expect(res.status).toBe(200);
    const mesh = (await res.json()) as { positions: number[]; indices: number[]; bbox: unknown; groups: unknown };
    expect(mesh.positions).toEqual([0, 0, 0, 1, 0, 0, 0, 1, 0]);
    expect(mesh.indices).toEqual([0, 1, 2]);
    expect(mesh.bbox).toEqual({ min: [0, 0, 0], max: [1, 1, 0] });
    expect(mesh.groups).toEqual([{ objectId: 2, extruder: null, start: 0, count: 3 }]);
  });

  test("400 when plate is missing", async () => {
    const id = repo.createJob({ filename: "p.3mf" });
    writeFileSync(join(cacheDir, `${id}.gcode.3mf`), threemf());
    expect((await app.request(`/api/plate-mesh?job=${id}`)).status).toBe(400);
  });

  test("404 when the artifact has no mesh for the plate", async () => {
    const id = repo.createJob({ filename: "p.3mf" });
    writeFileSync(join(cacheDir, `${id}.gcode.3mf`), threemfNoMesh());
    expect((await app.request(`/api/plate-mesh?job=${id}&plate=plate_1`)).status).toBe(404);
  });

  test("404 when there is no cached artifact", async () => {
    const id = repo.createJob({ filename: "p.3mf" });
    expect((await app.request(`/api/plate-mesh?job=${id}&plate=plate_1`)).status).toBe(404);
  });

  test("404 for a nonexistent job and a bad id", async () => {
    expect((await app.request("/api/plate-mesh?job=999999&plate=plate_1")).status).toBe(404);
    expect((await app.request("/api/plate-mesh?job=abc&plate=plate_1")).status).toBe(404);
  });
});
