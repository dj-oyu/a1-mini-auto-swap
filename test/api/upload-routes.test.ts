import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { strToU8, zipSync } from "fflate";
import { createUploadApp } from "../../src/api/upload-routes.ts";
import { openDb, type Db } from "../../src/db/index.ts";
import type { Repo } from "../../src/db/repo.ts";
import type { FilamentInfo } from "../../src/injection/threemf.ts";

const PLATE_GCODE = [
  "; HEADER_BLOCK_START",
  "; model_id = widget",
  "; name = plate_1",
  "; HEADER_BLOCK_END",
  "G28",
  "G1 X10 Y10",
  "M104 S0",
  "",
].join("\n");

const SETTINGS = JSON.stringify({
  filament_colour: ["#FF0000", "#0000FF"],
  filament_type: ["PLA", "PETG"],
});

function makeThreemf(): Buffer {
  return Buffer.from(
    zipSync({
      "Metadata/plate_1.gcode": strToU8(PLATE_GCODE),
      "Metadata/plate_1.gcode.md5": strToU8("stale-old-md5"),
      "Metadata/project_settings.config": strToU8(SETTINGS),
      "3D/3dmodel.model": strToU8("<model/>"),
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
  cacheDir = mkdtempSync(join(tmpdir(), "upload-"));
  app = createUploadApp({ repo, cacheDir });
});

afterEach(() => {
  rmSync(cacheDir, { recursive: true, force: true });
});

describe("POST /api/queue (spec ch8)", () => {
  test("stores the upload, creates a processing job, and returns the extracted filaments", async () => {
    const bytes = makeThreemf();
    const res = await app.request("/api/queue?filename=plate.gcode.3mf", {
      method: "POST",
      body: bytes,
    });
    expect(res.status).toBe(201);

    const body = (await res.json()) as { id: number; filaments: FilamentInfo[] };
    expect(body.filaments).toEqual([
      { index: 0, color: "#FF0000", type: "PLA" },
      { index: 1, color: "#0000FF", type: "PETG" },
    ]);

    const job = repo.getJob(body.id);
    expect(job).not.toBeNull();
    expect(job!.status).toBe("processing");
    expect(job!.filename).toBe("plate.gcode.3mf");
    expect(JSON.parse(job!.filaments!)).toEqual(body.filaments);

    const storedPath = join(cacheDir, `${body.id}.gcode.3mf`);
    expect(existsSync(storedPath)).toBe(true);
    expect(readFileSync(storedPath).equals(bytes)).toBe(true);
  });

  test("400s when the filename query param is missing", async () => {
    const res = await app.request("/api/queue", { method: "POST", body: makeThreemf() });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(typeof body.error).toBe("string");
    expect(repo.listJobs()).toEqual([]);
  });

  test("400s when the filename query param is empty", async () => {
    const res = await app.request("/api/queue?filename=", { method: "POST", body: makeThreemf() });
    expect(res.status).toBe(400);
    expect(repo.listJobs()).toEqual([]);
  });

  test("400s when the request body is empty", async () => {
    const res = await app.request("/api/queue?filename=plate.gcode.3mf", {
      method: "POST",
      body: new Uint8Array(0),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(typeof body.error).toBe("string");
    expect(repo.listJobs()).toEqual([]);
  });

  test("400s on an invalid archive, and leaves no job or cache file behind", async () => {
    const res = await app.request("/api/queue?filename=bad.gcode.3mf", {
      method: "POST",
      body: Buffer.from("not a zip"),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(typeof body.error).toBe("string");

    expect(repo.listJobs()).toEqual([]);
    // No file (from this or any other id) should have leaked into cacheDir.
    expect(readdirSync(cacheDir)).toEqual([]);
  });
});
