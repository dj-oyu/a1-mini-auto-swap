import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Hono } from "hono";
import { extractMesh, extractPlateMesh } from "../injection/threemf-mesh.ts";
import { cacheFileName } from "../core/artifact.ts";
import type { Repo } from "../db/repo.ts";

/**
 * 3D model mesh API (spec ch8 / spec 17 §9): `GET /api/queue/:id/model` returns
 * the merged triangle mesh parsed from the cached `.gcode.3mf`, as
 * `{ positions:number[], indices:number[] }`, for the Three.js preview to load.
 * Mirrors the other route apps: a plain Hono app, testable via `app.request(...)`,
 * mounted by main()/the harness.
 */
export function createModelApp(deps: { repo: Repo; cacheDir: string }): Hono {
  const { repo, cacheDir } = deps;
  const app = new Hono();

  app.get("/api/queue/:id/model", (c) => {
    const id = Number(c.req.param("id"));
    if (!Number.isInteger(id) || id <= 0) return c.json({ error: "invalid job id" }, 404);
    if (!repo.getJob(id)) return c.json({ error: "job not found" }, 404);

    const path = join(cacheDir, cacheFileName(id));
    if (!existsSync(path)) return c.json({ error: "no cached artifact for job" }, 404);

    let mesh;
    try {
      mesh = extractMesh(readFileSync(path));
    } catch {
      return c.json({ error: "could not read artifact" }, 404);
    }
    if (!mesh) return c.json({ error: "no mesh in artifact" }, 404);

    c.header("cache-control", "public, max-age=3600");
    return c.json(mesh);
  });

  // Per-plate mesh (task #23): `GET /api/plate-mesh?job=<id>&plate=<plate_N>`.
  // Unlike /model (whole-archive triangle soup, no transforms), this returns
  // ONLY the geometry of the selected plate with build/component transforms
  // applied — as `{ positions:number[], indices:number[], bbox, groups }` (see
  // PlateMesh). The client falls back to /model or the thumbnail on 404.
  app.get("/api/plate-mesh", (c) => {
    const id = Number(c.req.query("job"));
    const plate = c.req.query("plate") ?? "";
    if (!Number.isInteger(id) || id <= 0) return c.json({ error: "invalid job id" }, 404);
    if (!plate) return c.json({ error: "plate query param is required" }, 400);
    if (!repo.getJob(id)) return c.json({ error: "job not found" }, 404);

    const path = join(cacheDir, cacheFileName(id));
    if (!existsSync(path)) return c.json({ error: "no cached artifact for job" }, 404);

    let mesh;
    try {
      mesh = extractPlateMesh(readFileSync(path), plate);
    } catch {
      return c.json({ error: "could not read artifact" }, 404);
    }
    if (!mesh) return c.json({ error: "no mesh for plate" }, 404);

    c.header("cache-control", "public, max-age=3600");
    return c.json(mesh);
  });

  return app;
}
