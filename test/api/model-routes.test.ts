import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Hono } from "hono";
import { strToU8, zipSync } from "fflate";
import { createModelApp } from "../../src/api/model-routes.ts";
import { openDb, type Db } from "../../src/db/index.ts";
import type { Repo } from "../../src/db/repo.ts";

const MODEL = `<model><resources><object id="1"><mesh>
  <vertices><vertex x="0" y="0" z="0"/><vertex x="1" y="0" z="0"/><vertex x="0" y="1" z="0"/></vertices>
  <triangles><triangle v1="0" v2="1" v3="2"/></triangles>
</mesh></object></resources></model>`;

function threemfWithMesh(): Buffer {
  return Buffer.from(zipSync({ "3D/3dmodel.model": strToU8(MODEL) }));
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
  cacheDir = mkdtempSync(join(tmpdir(), "model-"));
  app = createModelApp({ repo, cacheDir });
});
afterEach(() => rmSync(cacheDir, { recursive: true, force: true }));

describe("GET /api/queue/:id/model (spec ch8)", () => {
  test("returns the parsed mesh JSON for a cached job", async () => {
    const id = repo.createJob({ filename: "p.3mf" });
    writeFileSync(join(cacheDir, `${id}.gcode.3mf`), threemfWithMesh());

    const res = await app.request(`/api/queue/${id}/model`);
    expect(res.status).toBe(200);
    const mesh = (await res.json()) as { positions: number[]; indices: number[] };
    expect(mesh.positions).toEqual([0, 0, 0, 1, 0, 0, 0, 1, 0]);
    expect(mesh.indices).toEqual([0, 1, 2]);
  });

  test("404s when the artifact has no mesh", async () => {
    const id = repo.createJob({ filename: "p.3mf" });
    writeFileSync(join(cacheDir, `${id}.gcode.3mf`), threemfNoMesh());
    expect((await app.request(`/api/queue/${id}/model`)).status).toBe(404);
  });

  test("404s when there is no cached artifact", async () => {
    const id = repo.createJob({ filename: "p.3mf" });
    expect((await app.request(`/api/queue/${id}/model`)).status).toBe(404);
  });

  test("404s for a nonexistent job and a bad id", async () => {
    expect((await app.request("/api/queue/999999/model")).status).toBe(404);
    expect((await app.request("/api/queue/abc/model")).status).toBe(404);
  });
});
