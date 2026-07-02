import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Hono } from "hono";
import { strToU8, zipSync } from "fflate";
import { createUiApp } from "../../src/api/ui-routes.ts";
import { openDb, type Db } from "../../src/db/index.ts";
import type { Repo } from "../../src/db/repo.ts";
import { cacheFileName } from "../../src/core/artifact.ts";

// Read-only preview modal (GET /ui/queue/:id/preview): a multi-plate 3mf shows a
// horizontal tab strip + one large per-plate viewer wired to /api/plate-mesh;
// clicking a tab swaps the plate in the same viewer (viewer.js). Single/none →
// one large viewer, no tab strip.

let dbh: Db;
let repo: Repo;
let app: Hono;
let cacheDir: string;

beforeEach(() => {
  dbh = openDb(":memory:");
  repo = dbh.repo;
  cacheDir = mkdtempSync(join(tmpdir(), "preview-tabs-"));
  app = createUiApp({ repo, cacheDir });
});
afterEach(() => rmSync(cacheDir, { recursive: true, force: true }));

/** Cache a PROJECT 3mf (model_settings plater_id plates, no gcode). */
function writeProjectThreemf(id: number, platerIds: number[]): void {
  const plates = platerIds
    .map((n) => `<plate><metadata key="plater_id" value="${n}"/><model_instance><metadata key="object_id" value="${n * 2}"/></model_instance></plate>`)
    .join("");
  writeFileSync(
    join(cacheDir, cacheFileName(id)),
    Buffer.from(
      zipSync({
        "3D/3dmodel.model": strToU8("<model><resources/></model>"),
        "Metadata/model_settings.config": strToU8(`<config>${plates}</config>`),
      }),
    ),
  );
}

async function previewHtml(id: number): Promise<string> {
  return await (await app.request(`/ui/queue/${id}/preview`)).text();
}

/** Count occurrences of a substring. */
function count(hay: string, needle: string): number {
  return hay.split(needle).length - 1;
}

describe("GET /ui/queue/:id/preview — plate tabs", () => {
  test("a multi-plate (project) 3mf renders one tab per plate with the correct plate ids", async () => {
    const id = repo.createJob({ filename: "a-d.3mf" });
    writeProjectThreemf(id, [1, 2, 3, 4]);
    const text = await previewHtml(id);

    // tab strip present, one tablist
    expect(text).toContain('class="plate-tabs"');
    expect(text).toContain('role="tablist"');
    // exactly 4 tab chips (role="tab"; "tablist" does not match), each with its id
    expect(count(text, 'role="tab"')).toBe(4);
    for (const n of [1, 2, 3, 4]) expect(text).toContain(`data-plate="plate_${n}"`);
    // first tab is active
    expect(text).toMatch(/class="plate-tab is-active"[^>]*data-plate="plate_1"/);

    // one large viewer wired to the per-plate mesh endpoint, seeded to plate_1
    expect(text).toContain('class="viewer viewer-large"');
    expect(text).toContain(`data-plate-mesh="/api/plate-mesh?job=${id}"`);
    expect(text).toContain('data-plate="plate_1"');
  });

  test("a single-plate 3mf renders one large viewer and NO tab strip", async () => {
    const id = repo.createJob({ filename: "one.3mf" });
    writeProjectThreemf(id, [1]);
    const text = await previewHtml(id);

    expect(text).not.toContain("plate-tabs");
    expect(text).not.toContain("plate-tab");
    expect(text).toContain('class="viewer viewer-large"');
    // still per-plate (seeded), so the viewer shows just that plate
    expect(text).toContain(`data-plate-mesh="/api/plate-mesh?job=${id}"`);
    expect(text).toContain('data-plate="plate_1"');
  });

  test("no cached artifact → whole-archive large viewer, no tabs, no plate-mesh", async () => {
    const id = repo.createJob({ filename: "none.3mf" });
    const text = await previewHtml(id);

    expect(text).not.toContain("plate-tabs");
    expect(text).toContain('class="viewer viewer-large"');
    expect(text).toContain(`data-model-url="/api/queue/${id}/model"`);
    expect(text).not.toContain("data-plate-mesh");
  });
});
