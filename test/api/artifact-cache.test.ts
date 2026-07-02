import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Hono } from "hono";
import { strToU8, zipSync } from "fflate";
import { createModelApp } from "../../src/api/model-routes.ts";
import { createThumbnailApp } from "../../src/api/thumbnail-routes.ts";
import { openDb, type Db } from "../../src/db/index.ts";
import type { Repo } from "../../src/db/repo.ts";
import { cacheFileName } from "../../src/core/artifact.ts";

// Regression for the "Letters preview shows a-d's plates" bug: the mesh /
// thumbnail endpoints are keyed only by job id (cacheFileName), and a job id can
// be REUSED (harness restart; SQLite rowid reuse). Serving them with a long
// `cache-control: public, max-age=3600` let a browser reuse a PRIOR job's mesh
// for the identical URL. The endpoints must instead revalidate (`no-cache`) with
// an ETag that changes when the cached bytes change, so a new upload behind the
// same id is never served stale.

/** A tiny project 3mf whose plate_1 mesh vertex is `tag` on x — distinct `tag`
 *  ⇒ distinct geometry AND (using different digit lengths) distinct file size. */
function meshThreemf(tag: number): Buffer {
  const root = `<model xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" xmlns:p="http://schemas.microsoft.com/3dmanufacturing/production/2015/06">
   <resources><object id="2" type="model"><components>
     <component p:path="/3D/Objects/object_1.model" objectid="1" transform="1 0 0 0 1 0 0 0 1 0 0 0"/>
   </components></object></resources>
   <build><item objectid="2" transform="1 0 0 0 1 0 0 0 1 0 0 0"/></build></model>`;
  const part = `<model xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"><resources><object id="1" type="model"><mesh>
     <vertices><vertex x="0" y="0" z="0"/><vertex x="${tag}" y="0" z="0"/><vertex x="0" y="${tag}" z="0"/></vertices>
     <triangles><triangle v1="0" v2="1" v3="2"/></triangles></mesh></object></resources></model>`;
  const settings = `<config><plate><metadata key="plater_id" value="1"/><model_instance><metadata key="object_id" value="2"/></model_instance></plate></config>`;
  return Buffer.from(
    zipSync({
      "3D/3dmodel.model": strToU8(root),
      "3D/Objects/object_1.model": strToU8(part),
      "Metadata/model_settings.config": strToU8(settings),
      // a distinct-length thumbnail so the thumbnail body + size also change
      "Metadata/plate_1.png": strToU8("PNG".repeat(tag)),
    }),
  );
}

let dbh: Db;
let repo: Repo;
let model: Hono;
let thumb: Hono;
let cacheDir: string;
let id: number;

beforeEach(() => {
  dbh = openDb(":memory:");
  repo = dbh.repo;
  cacheDir = mkdtempSync(join(tmpdir(), "artifact-cache-"));
  model = createModelApp({ repo, cacheDir });
  thumb = createThumbnailApp({ repo, cacheDir });
  id = repo.createJob({ filename: "p.3mf" });
});
afterEach(() => rmSync(cacheDir, { recursive: true, force: true }));

function writeCache(bytes: Buffer): void {
  writeFileSync(join(cacheDir, cacheFileName(id)), bytes);
}

describe("id-keyed artifact endpoints revalidate (no cross-job stale)", () => {
  test("GET /api/plate-mesh: no long-cache header, carries an ETag", async () => {
    writeCache(meshThreemf(1));
    const res = await model.request(`/api/plate-mesh?job=${id}&plate=plate_1`);
    expect(res.status).toBe(200);
    const cc = res.headers.get("cache-control") ?? "";
    expect(cc).toContain("no-cache");
    expect(cc).not.toContain("max-age=3600");
    expect(cc).not.toContain("public");
    expect(res.headers.get("etag")).toBeTruthy();
  });

  test("GET /api/plate-mesh: overwriting the SAME id's cache serves the NEW mesh (the bug)", async () => {
    writeCache(meshThreemf(1));
    const first = (await (await model.request(`/api/plate-mesh?job=${id}&plate=plate_1`)).json()) as {
      positions: number[];
    };
    expect(first.positions).toEqual([0, 0, 0, 1, 0, 0, 0, 1, 0]);

    // Same job id, different upload (a-d → Letters). An unconditional request
    // must reflect the new bytes, never the cached prior mesh.
    writeCache(meshThreemf(12345));
    const second = (await (await model.request(`/api/plate-mesh?job=${id}&plate=plate_1`)).json()) as {
      positions: number[];
    };
    expect(second.positions).toEqual([0, 0, 0, 12345, 0, 0, 0, 12345, 0]);
  });

  test("GET /api/plate-mesh: revalidation — matching ETag 304s, a stale ETag after overwrite 200s fresh", async () => {
    writeCache(meshThreemf(1));
    const r1 = await model.request(`/api/plate-mesh?job=${id}&plate=plate_1`);
    const etag1 = r1.headers.get("etag")!;
    expect(etag1).toBeTruthy();

    // Unchanged file + matching validator → 304 Not Modified (cheap revalidate).
    const notMod = await model.request(`/api/plate-mesh?job=${id}&plate=plate_1`, {
      headers: { "if-none-match": etag1 },
    });
    expect(notMod.status).toBe(304);

    // Overwrite behind the same id: the OLD validator must no longer match.
    writeCache(meshThreemf(12345));
    const r2 = await model.request(`/api/plate-mesh?job=${id}&plate=plate_1`, {
      headers: { "if-none-match": etag1 },
    });
    expect(r2.status).toBe(200);
    expect(r2.headers.get("etag")).not.toBe(etag1);
    const body = (await r2.json()) as { positions: number[] };
    expect(body.positions).toEqual([0, 0, 0, 12345, 0, 0, 0, 12345, 0]);
  });

  test("GET /api/queue/:id/model: overwriting the same id serves the NEW geometry + no long cache", async () => {
    writeCache(meshThreemf(1));
    const a = (await (await model.request(`/api/queue/${id}/model`)).json()) as { positions: number[] };
    expect(a.positions).toEqual([0, 0, 0, 1, 0, 0, 0, 1, 0]);

    const r0 = await model.request(`/api/queue/${id}/model`);
    expect(r0.headers.get("cache-control")).toContain("no-cache");
    expect(r0.headers.get("cache-control") ?? "").not.toContain("max-age=3600");

    writeCache(meshThreemf(12345));
    const b = (await (await model.request(`/api/queue/${id}/model`)).json()) as { positions: number[] };
    expect(b.positions).toEqual([0, 0, 0, 12345, 0, 0, 0, 12345, 0]);
  });

  test("GET /api/queue/:id/thumbnail: no long-cache header + fresh bytes after overwrite", async () => {
    writeCache(meshThreemf(1));
    const r1 = await thumb.request(`/api/queue/${id}/thumbnail`);
    expect(r1.status).toBe(200);
    expect(r1.headers.get("cache-control")).toContain("no-cache");
    expect(r1.headers.get("cache-control") ?? "").not.toContain("max-age=3600");
    const len1 = (await r1.arrayBuffer()).byteLength;

    writeCache(meshThreemf(12345));
    const r2 = await thumb.request(`/api/queue/${id}/thumbnail`);
    const len2 = (await r2.arrayBuffer()).byteLength;
    expect(len2).not.toBe(len1); // new thumbnail bytes, not the cached prior one
  });
});
