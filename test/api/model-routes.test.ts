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

// A synthetic sliced .gcode.3mf with a G1 move and a G2/G3 arc line, so the
// route returns REAL gcode text (not just a header). The arc line also documents
// that Bambu's default arc fitting is preserved end-to-end (gcode-preview parses
// G2/G3; the route just ships the bytes).
const PLATE_1_GCODE = [
  "; HEADER_BLOCK_START",
  "; name = plate_1",
  "; HEADER_BLOCK_END",
  "M83",
  "G1 X10 Y10 E0.5 F1800",
  "G2 X20 Y20 I5 J5 E0.5", // clockwise arc (Bambu default arc fitting)
  "G3 X10 Y10 I-5 J-5 E0.5", // counter-clockwise arc
  "",
].join("\n");
const PLATE_2_GCODE = ["; HEADER_BLOCK_START", "; name = plate_2", "; HEADER_BLOCK_END", "G1 X5 Y5 E0.1", ""].join("\n");

/** A sliced multi-plate .gcode.3mf (mesh stripped — only plate gcodes). */
function slicedThreemf(): Buffer {
  return Buffer.from(
    zipSync({
      "Metadata/plate_1.gcode": strToU8(PLATE_1_GCODE),
      "Metadata/plate_2.gcode": strToU8(PLATE_2_GCODE),
      "Metadata/project_settings.config": strToU8("{}"),
    }),
  );
}

describe("GET /api/queue/:id/gcode?plate=plate_N (Part A)", () => {
  test("returns the selected plate's gcode text (with its G2/G3 arcs) as text/plain", async () => {
    const id = repo.createJob({ filename: "sliced.gcode.3mf" });
    writeFileSync(join(cacheDir, `${id}.gcode.3mf`), slicedThreemf());

    const res = await app.request(`/api/queue/${id}/gcode?plate=plate_1`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/plain");
    const text = await res.text();
    expect(text).toContain("G1 X10 Y10");
    expect(text).toContain("G2 X20 Y20"); // the arc survives round-trip
    expect(text).toContain("G3 X10 Y10");
    // it returned plate_1, not plate_2
    expect(text).not.toContain("X5 Y5");
  });

  test("serves a different plate for a different query", async () => {
    const id = repo.createJob({ filename: "sliced.gcode.3mf" });
    writeFileSync(join(cacheDir, `${id}.gcode.3mf`), slicedThreemf());
    const text = await (await app.request(`/api/queue/${id}/gcode?plate=plate_2`)).text();
    expect(text).toContain("X5 Y5");
    expect(text).not.toContain("G2 X20");
  });

  test("400 for a malformed plate param", async () => {
    const id = repo.createJob({ filename: "sliced.gcode.3mf" });
    writeFileSync(join(cacheDir, `${id}.gcode.3mf`), slicedThreemf());
    expect((await app.request(`/api/queue/${id}/gcode?plate=../evil`)).status).toBe(400);
    expect((await app.request(`/api/queue/${id}/gcode?plate=`)).status).toBe(400);
    expect((await app.request(`/api/queue/${id}/gcode`)).status).toBe(400);
  });

  test("404 for a well-formed but absent plate", async () => {
    const id = repo.createJob({ filename: "sliced.gcode.3mf" });
    writeFileSync(join(cacheDir, `${id}.gcode.3mf`), slicedThreemf());
    expect((await app.request(`/api/queue/${id}/gcode?plate=plate_99`)).status).toBe(404);
  });

  test("404 for an unsliced/project 3mf (no plate gcode)", async () => {
    const id = repo.createJob({ filename: "project.3mf" });
    writeFileSync(join(cacheDir, `${id}.gcode.3mf`), threemfWithMesh()); // mesh only, no gcode
    expect((await app.request(`/api/queue/${id}/gcode?plate=plate_1`)).status).toBe(404);
  });

  test("404 for a missing job / missing artifact / bad id", async () => {
    expect((await app.request("/api/queue/999999/gcode?plate=plate_1")).status).toBe(404);
    expect((await app.request("/api/queue/abc/gcode?plate=plate_1")).status).toBe(404);
    const id = repo.createJob({ filename: "nocache.3mf" }); // no file written
    expect((await app.request(`/api/queue/${id}/gcode?plate=plate_1`)).status).toBe(404);
  });

  test("the ETag differs per plate and revalidates (no long-cache)", async () => {
    const id = repo.createJob({ filename: "sliced.gcode.3mf" });
    writeFileSync(join(cacheDir, `${id}.gcode.3mf`), slicedThreemf());
    const r1 = await app.request(`/api/queue/${id}/gcode?plate=plate_1`);
    const r2 = await app.request(`/api/queue/${id}/gcode?plate=plate_2`);
    const e1 = r1.headers.get("etag");
    const e2 = r2.headers.get("etag");
    expect(e1).toBeTruthy();
    expect(e2).toBeTruthy();
    expect(e1).not.toBe(e2); // plate folded into the validator
    expect(r1.headers.get("cache-control")).toBe("no-cache");
    // If-None-Match with the matching validator → 304
    const r304 = await app.request(`/api/queue/${id}/gcode?plate=plate_1`, {
      headers: { "if-none-match": e1! },
    });
    expect(r304.status).toBe(304);
  });
});
