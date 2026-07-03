import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Hono } from "hono";
import { strFromU8, unzipSync } from "fflate";
import { extractMesh, extractPlateMesh } from "../injection/threemf-mesh.ts";
import { cacheFileName } from "../core/artifact.ts";
import { artifactETag } from "./http-cache.ts";
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

    // Revalidate, don't long-cache: the file behind this id-keyed URL is mutable
    // (job-id reuse), so a stale cached body must never be served (see http-cache).
    const etag = artifactETag(path, "model");
    c.header("cache-control", "no-cache");
    if (etag) {
      c.header("etag", etag);
      if (c.req.header("if-none-match") === etag) return c.body(null, 304);
    }

    let mesh;
    try {
      mesh = extractMesh(readFileSync(path));
    } catch {
      return c.json({ error: "could not read artifact" }, 404);
    }
    if (!mesh) return c.json({ error: "no mesh in artifact" }, 404);

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

    // Revalidate against a validator keyed on the file bytes AND the plate (the
    // plate selects a different slice of the same file). Prevents a reused job
    // id from serving a prior upload's plate mesh for the identical URL.
    const etag = artifactETag(path, `plate:${plate}`);
    c.header("cache-control", "no-cache");
    if (etag) {
      c.header("etag", etag);
      if (c.req.header("if-none-match") === etag) return c.body(null, 304);
    }

    let mesh;
    try {
      mesh = extractPlateMesh(readFileSync(path), plate);
    } catch {
      return c.json({ error: "could not read artifact" }, 404);
    }
    if (!mesh) return c.json({ error: "no mesh for plate" }, 404);

    return c.json(mesh);
  });

  // Per-plate G-CODE toolpath source: `GET /api/queue/:id/gcode?plate=plate_N`.
  // A sliced `.gcode.3mf` STRIPS the 3D mesh (`3D/Objects/*.model` absent) but
  // ships the printable `Metadata/plate_N.gcode` — the only real geometry in a
  // printable file. The gcode-preview client (gviewer.js) fetches this and draws
  // the toolpath (G0/G1 + Bambu's default G2/G3 arcs). Returns text/plain, and
  // mirrors the mesh routes' revalidate-every-time cache (the id-keyed cache file
  // is mutable on job-id reuse). Never long-caches. ~30 lines.
  app.get("/api/queue/:id/gcode", (c) => {
    const id = Number(c.req.param("id"));
    if (!Number.isInteger(id) || id <= 0) return c.json({ error: "invalid job id" }, 404);
    // `plate` selects one Metadata/plate_N.gcode. A malformed value is a client
    // bug (400), distinct from a well-formed but absent plate/job/artifact (404).
    const plate = c.req.query("plate") ?? "";
    if (!/^plate_\d+$/i.test(plate)) return c.json({ error: "malformed plate" }, 400);
    if (!repo.getJob(id)) return c.json({ error: "job not found" }, 404);

    const path = join(cacheDir, cacheFileName(id));
    if (!existsSync(path)) return c.json({ error: "no cached artifact for job" }, 404);

    // Validator keyed on file bytes AND the plate (different plate ⇒ different
    // gcode from the same file), so a reused job id can never serve a stale plate.
    const etag = artifactETag(path, "gcode", `plate:${plate}`);
    c.header("cache-control", "no-cache");
    if (etag) {
      c.header("etag", etag);
      if (c.req.header("if-none-match") === etag) return c.body(null, 304);
    }

    const entry = `Metadata/${plate}.gcode`;
    let text: string;
    try {
      // Decompress ONLY this plate's gcode (fflate filter) — a 26-plate archive
      // must not inflate every plate's gcode to serve one.
      const files = unzipSync(readFileSync(path), { filter: (f) => f.name === entry });
      const bytes = files[entry];
      if (!bytes) return c.json({ error: "no gcode for plate" }, 404);
      text = strFromU8(bytes);
    } catch {
      return c.json({ error: "could not read artifact" }, 404);
    }
    return c.text(text);
  });

  return app;
}
