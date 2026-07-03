import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Hono } from "hono";
import { strToU8, zipSync } from "fflate";
import { createThumbnailApp } from "../../src/api/thumbnail-routes.ts";
import { openDb, type Db } from "../../src/db/index.ts";
import type { Repo } from "../../src/db/repo.ts";

const PNG = strToU8("\x89PNG\r\n\x1a\n-plate");

function threemfWithPng(): Buffer {
  return Buffer.from(zipSync({ "Metadata/plate_1.png": PNG, "Metadata/project_settings.config": strToU8("{}") }));
}
function threemfNoPng(): Buffer {
  return Buffer.from(zipSync({ "Metadata/project_settings.config": strToU8("{}") }));
}
function threemfMultiPlatePng(): Buffer {
  return Buffer.from(
    zipSync({
      "Metadata/plate_1.png": strToU8("\x89PNG\r\n\x1a\n-PLATE-ONE"),
      "Metadata/plate_2.png": strToU8("\x89PNG\r\n\x1a\n-PLATE-TWO"),
      "Metadata/project_settings.config": strToU8("{}"),
    }),
  );
}

let dbh: Db;
let repo: Repo;
let app: Hono;
let cacheDir: string;

beforeEach(() => {
  dbh = openDb(":memory:");
  repo = dbh.repo;
  cacheDir = mkdtempSync(join(tmpdir(), "thumb-"));
  app = createThumbnailApp({ repo, cacheDir });
});
afterEach(() => rmSync(cacheDir, { recursive: true, force: true }));

describe("GET /api/queue/:id/thumbnail (spec ch8)", () => {
  test("serves the embedded PNG for a cached job", async () => {
    const id = repo.createJob({ filename: "p.3mf" });
    writeFileSync(join(cacheDir, `${id}.gcode.3mf`), threemfWithPng());

    const res = await app.request(`/api/queue/${id}/thumbnail`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect(Buffer.from(bytes).toString()).toContain("plate");
  });

  test("404s when the job exists but the artifact has no thumbnail", async () => {
    const id = repo.createJob({ filename: "p.3mf" });
    writeFileSync(join(cacheDir, `${id}.gcode.3mf`), threemfNoPng());
    const res = await app.request(`/api/queue/${id}/thumbnail`);
    expect(res.status).toBe(404);
  });

  test("404s when there is no cached artifact for the job", async () => {
    const id = repo.createJob({ filename: "p.3mf" }); // nothing written to cache
    const res = await app.request(`/api/queue/${id}/thumbnail`);
    expect(res.status).toBe(404);
  });

  test("404s for a nonexistent job", async () => {
    const res = await app.request("/api/queue/999999/thumbnail");
    expect(res.status).toBe(404);
  });

  test("404s for a non-positive-integer id", async () => {
    for (const bad of ["0", "-1", "abc"]) {
      expect((await app.request(`/api/queue/${bad}/thumbnail`)).status).toBe(404);
    }
  });
});

describe("GET /api/queue/:id/thumbnail?plate=plate_N (per-plate render, fix 2)", () => {
  test("serves the REQUESTED plate's PNG, not another plate's", async () => {
    const id = repo.createJob({ filename: "multi.3mf" });
    writeFileSync(join(cacheDir, `${id}.gcode.3mf`), threemfMultiPlatePng());

    const res = await app.request(`/api/queue/${id}/thumbnail?plate=plate_2`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(Buffer.from(new Uint8Array(await res.arrayBuffer())).toString()).toContain("PLATE-TWO");
  });

  test("404s for a plate with no embedded PNG", async () => {
    const id = repo.createJob({ filename: "multi.3mf" });
    writeFileSync(join(cacheDir, `${id}.gcode.3mf`), threemfMultiPlatePng());
    expect((await app.request(`/api/queue/${id}/thumbnail?plate=plate_9`)).status).toBe(404);
  });

  test("the ETag differs per plate (plate_1 and plate_2 never collide)", async () => {
    const id = repo.createJob({ filename: "multi.3mf" });
    writeFileSync(join(cacheDir, `${id}.gcode.3mf`), threemfMultiPlatePng());
    const e1 = (await app.request(`/api/queue/${id}/thumbnail?plate=plate_1`)).headers.get("etag");
    const e2 = (await app.request(`/api/queue/${id}/thumbnail?plate=plate_2`)).headers.get("etag");
    const eOverall = (await app.request(`/api/queue/${id}/thumbnail`)).headers.get("etag");
    expect(e1).toBeTruthy();
    expect(e1).not.toBe(e2);
    expect(e1).not.toBe(eOverall);
  });

  test("no plate query keeps the overall-thumbnail behaviour unchanged", async () => {
    const id = repo.createJob({ filename: "p.3mf" });
    writeFileSync(join(cacheDir, `${id}.gcode.3mf`), threemfWithPng());
    const res = await app.request(`/api/queue/${id}/thumbnail`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(Buffer.from(new Uint8Array(await res.arrayBuffer())).toString()).toContain("plate");
  });
});
