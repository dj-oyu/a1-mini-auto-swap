import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Hono } from "hono";
import { strToU8, zipSync } from "fflate";
import { createWriteApp } from "../../src/api/write-routes.ts";
import { Dispatcher } from "../../src/core/dispatcher.ts";
import type { PrinterPort } from "../../src/core/ports.ts";
import { cacheFileName } from "../../src/core/artifact.ts";
import { openDb, type Db } from "../../src/db/index.ts";
import type { Repo } from "../../src/db/repo.ts";
import type { JobRow } from "../../src/db/types.ts";

// Multi-plate SELECTION + fan-out (plate-multiselect): PATCH
// /api/queue/:id/filaments with an ORDERED `selected_plates` list creates one
// QUEUED job per element (order + duplicates significant — it spells words), each
// with its own copied cached artifact, all sharing the chosen project.

class FakePrinter implements PrinterPort {
  async startPrint(_job: JobRow): Promise<void> {}
  async ejectAndReset(): Promise<void> {}
  async resumeWithAlternateSlot(_jobId: number, _slot: number): Promise<void> {}
}

const PLATE_GCODE = ["; HEADER_BLOCK_START", "; name = p", "; HEADER_BLOCK_END", "G28", ""].join("\n");

/** A .gcode.3mf carrying the given gcode plate numbers (printable plates). */
function multiPlateThreemf(plateNums: number[]): Buffer {
  const files: Record<string, Uint8Array> = {
    "Metadata/project_settings.config": strToU8(
      JSON.stringify({ filament_colour: ["#ff0000"], filament_type: ["PLA"] }),
    ),
    "3D/3dmodel.model": strToU8("<model><resources/></model>"),
  };
  for (const n of plateNums) files[`Metadata/plate_${n}.gcode`] = strToU8(PLATE_GCODE);
  return Buffer.from(zipSync(files));
}

let dbh: Db;
let repo: Repo;
let dispatcher: Dispatcher;
let app: Hono;
let cacheDir: string;

beforeEach(() => {
  dbh = openDb(":memory:");
  repo = dbh.repo;
  dispatcher = new Dispatcher(repo, new FakePrinter());
  cacheDir = mkdtempSync(join(tmpdir(), "fanout-"));
  app = createWriteApp({ repo, dispatcher, cacheDir });
});
afterEach(() => rmSync(cacheDir, { recursive: true, force: true }));

/** Create a processing job whose cached archive carries `plateNums` plates. */
function seedJob(plateNums: number[], filename = "abc.gcode.3mf"): number {
  const id = repo.createJob({ filename, filaments: [{ slot: 1, color: "#ff0000", type: "PLA" }] });
  writeFileSync(join(cacheDir, cacheFileName(id)), multiPlateThreemf(plateNums));
  return id;
}

const patch = (id: number | string, body: unknown) =>
  app.request(`/api/queue/${id}/filaments`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

describe("PATCH /api/queue/:id/filaments — multi-plate fan-out", () => {
  test("K>1 plates → K queued jobs in array order, original is the first", async () => {
    const proj = repo.createProject("Letters");
    const id = seedJob([1, 2, 3]);
    const res = await patch(id, {
      ams_mapping: [0, -1, -1, -1],
      project_id: proj,
      selected_plates: ["plate_1", "plate_2", "plate_3"],
    });
    expect(res.status).toBe(200);

    const jobs = repo.listJobs(); // ordered by position asc
    expect(jobs.length).toBe(3);
    // all queued, all in this project, plate order ascending, original included
    expect(jobs.map((j) => j.status)).toEqual(["queued", "queued", "queued"]);
    expect(jobs.map((j) => j.selected_plate)).toEqual(["plate_1", "plate_2", "plate_3"]);
    expect(jobs.every((j) => j.project_id === proj)).toBe(true);
    expect(jobs.some((j) => j.id === id)).toBe(true);
    expect(repo.getJob(id)?.selected_plate).toBe("plate_1");

    // each job has its own cached artifact copy present
    for (const j of jobs) {
      expect(existsSync(join(cacheDir, cacheFileName(j.id)))).toBe(true);
    }
    // clone artifacts are byte-identical copies of the source
    const src = readFileSync(join(cacheDir, cacheFileName(id)));
    for (const j of jobs) {
      expect(readFileSync(join(cacheDir, cacheFileName(j.id))).equals(src)).toBe(true);
    }
  });

  test('ORDER + REPEATS preserved: ["plate_2","plate_1","plate_2"] → B,O,B sequence', async () => {
    const id = seedJob([1, 2, 3]);
    const res = await patch(id, {
      ams_mapping: [0, -1, -1, -1],
      selected_plates: ["plate_2", "plate_1", "plate_2"],
    });
    expect(res.status).toBe(200);

    const jobs = repo.listJobs();
    expect(jobs.length).toBe(3);
    // duplicates NOT collapsed; queue position follows the exact sequence
    expect(jobs.map((j) => j.selected_plate)).toEqual(["plate_2", "plate_1", "plate_2"]);
    // the original job is the first element of the sequence
    expect(jobs[0]!.id).toBe(id);
  });

  test("1 plate → exactly one job (unchanged), no clone", async () => {
    const id = seedJob([1, 2]);
    const res = await patch(id, { ams_mapping: [0, -1, -1, -1], selected_plates: ["plate_2"] });
    expect(res.status).toBe(200);
    expect(repo.listJobs().length).toBe(1);
    expect(repo.getJob(id)?.selected_plate).toBe("plate_2");
    expect(repo.getJob(id)?.status).toBe("queued");
  });

  test("unknown plate → 400, no jobs created/enqueued, job left processing", async () => {
    const id = seedJob([1, 2]);
    const res = await patch(id, {
      ams_mapping: [0, -1, -1, -1],
      selected_plates: ["plate_1", "plate_9"],
    });
    expect(res.status).toBe(400);
    expect(repo.listJobs().length).toBe(1); // no clones
    expect(repo.getJob(id)?.status).toBe("processing"); // not enqueued
    expect(repo.getJob(id)?.selected_plate).toBeNull();
  });

  test("empty selected_plates array → legacy single-plate path (no fan-out)", async () => {
    const id = seedJob([1, 2]);
    const res = await patch(id, {
      ams_mapping: [0, -1, -1, -1],
      selected_plate: "plate_2",
      selected_plates: [],
    });
    expect(res.status).toBe(200);
    expect(repo.listJobs().length).toBe(1);
    expect(repo.getJob(id)?.selected_plate).toBe("plate_2");
  });

  test("no plate fields at all → unchanged single job, no selected_plate", async () => {
    const id = seedJob([1]);
    const res = await patch(id, { ams_mapping: [0, -1, -1, -1] });
    expect(res.status).toBe(200);
    expect(repo.listJobs().length).toBe(1);
    expect(repo.getJob(id)?.selected_plate).toBeNull();
    expect(repo.getJob(id)?.status).toBe("queued");
  });

  test("legacy singular selected_plate still works", async () => {
    const id = seedJob([24]);
    const res = await patch(id, { ams_mapping: [0, -1, -1, -1], selected_plate: "plate_24" });
    expect(res.status).toBe(200);
    expect(repo.getJob(id)?.selected_plate).toBe("plate_24");
    expect(repo.listJobs().length).toBe(1);
  });

  test("clones inherit the same filaments + ams_mapping as the original", async () => {
    const id = seedJob([1, 2]);
    await patch(id, {
      ams_mapping: [2, -1, -1, -1],
      filaments: [{ slot: 1, color: "#abcdef" }],
      selected_plates: ["plate_1", "plate_2"],
    });
    const jobs = repo.listJobs();
    expect(jobs.length).toBe(2);
    for (const j of jobs) {
      expect(JSON.parse(j.ams_mapping!)).toEqual([2, -1, -1, -1]);
      expect(JSON.parse(j.filaments!)).toEqual([{ slot: 1, color: "#abcdef" }]);
    }
  });

  test('A–Z model, user spells "BOB" → 3 jobs B,O,B; plate_B is two independent jobs', async () => {
    // Letters A..Z on plate_1..plate_26 (B=plate_2, O=plate_15).
    const proj = repo.createProject("Alphabet");
    const nums = Array.from({ length: 26 }, (_, i) => i + 1);
    const id = seedJob(nums, "alphabet.gcode.3mf");
    const B = "plate_2";
    const O = "plate_15";

    const res = await patch(id, {
      ams_mapping: [0, -1, -1, -1],
      project_id: proj,
      selected_plates: [B, O, B], // B, O, B
    });
    expect(res.status).toBe(200);

    const jobs = repo.listJobs(); // position asc = sequence order
    expect(jobs.length).toBe(3);
    // exact sequence preserved, duplicates NOT collapsed
    expect(jobs.map((j) => j.selected_plate)).toEqual([B, O, B]);
    // the two B's are DISTINCT jobs (independent queue entries)
    const bJobs = jobs.filter((j) => j.selected_plate === B);
    expect(bJobs.length).toBe(2);
    expect(bJobs[0]!.id).not.toBe(bJobs[1]!.id);
    // first B is the original job
    expect(jobs[0]!.id).toBe(id);
    // all three queued, all in the chosen project
    expect(jobs.every((j) => j.status === "queued" && j.project_id === proj)).toBe(true);
    // each job — including both B's — has its OWN cached artifact copy
    for (const j of jobs) {
      expect(existsSync(join(cacheDir, cacheFileName(j.id)))).toBe(true);
    }
    const paths = new Set(jobs.map((j) => join(cacheDir, cacheFileName(j.id))));
    expect(paths.size).toBe(3); // three distinct files
  });

  test("fan-out with no cached artifact → 400, nothing created", async () => {
    // job exists but its cache file was never written
    const id = repo.createJob({ filename: "x.gcode.3mf" });
    const res = await patch(id, {
      ams_mapping: [0, -1, -1, -1],
      selected_plates: ["plate_1", "plate_2"],
    });
    expect(res.status).toBe(400);
    expect(repo.listJobs().length).toBe(1);
    expect(repo.getJob(id)?.status).toBe("processing");
  });
});
