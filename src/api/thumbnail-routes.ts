import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Hono } from "hono";
import { extractThumbnail } from "../injection/threemf.ts";
import type { Repo } from "../db/repo.ts";

/**
 * Thumbnail HTTP API (spec ch8 / spec 17 §6): `GET /api/queue/:id/thumbnail`
 * serves the plate render PNG embedded in the cached `.gcode.3mf`, so the queue
 * cards + confirm modal can show "the right model is on the plate" before it
 * prints — the visual pre-print check. Mirrors the other route apps: a plain
 * Hono app, testable via `app.request(...)`, mounted by main()/the harness.
 */
export function createThumbnailApp(deps: { repo: Repo; cacheDir: string }): Hono {
  const { repo, cacheDir } = deps;
  const app = new Hono();

  app.get("/api/queue/:id/thumbnail", (c) => {
    const id = Number(c.req.param("id"));
    if (!Number.isInteger(id) || id <= 0) return c.json({ error: "invalid job id" }, 404);
    if (!repo.getJob(id)) return c.json({ error: "job not found" }, 404);

    const path = join(cacheDir, `${id}.gcode.3mf`);
    if (!existsSync(path)) return c.json({ error: "no cached artifact for job" }, 404);

    let png: Uint8Array | null;
    try {
      png = extractThumbnail(readFileSync(path));
    } catch {
      return c.json({ error: "could not read artifact" }, 404);
    }
    if (!png) return c.json({ error: "no thumbnail in artifact" }, 404);

    c.header("content-type", "image/png");
    c.header("cache-control", "public, max-age=3600");
    return c.body(png as Uint8Array<ArrayBuffer>);
  });

  return app;
}
