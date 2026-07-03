import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Hono } from "hono";
import { extractPlateThumbnail, extractThumbnail } from "../injection/threemf.ts";
import { cacheFileName } from "../core/artifact.ts";
import { artifactETag } from "./http-cache.ts";
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

    const path = join(cacheDir, cacheFileName(id));
    if (!existsSync(path)) return c.json({ error: "no cached artifact for job" }, 404);

    // `?plate=plate_N` selects ONE plate's render (sequence-builder chips); no
    // plate query keeps the overall-thumbnail behaviour byte-for-byte.
    const plate = c.req.query("plate");

    // Revalidate, don't long-cache: same id-keyed mutable artifact as the mesh
    // routes — a reused job id must not serve a prior upload's thumbnail. Fold
    // the plate into the validator so plate_1 vs plate_2 never share an ETag.
    const etag = plate ? artifactETag(path, "thumb", `plate:${plate}`) : artifactETag(path, "thumb");
    c.header("cache-control", "no-cache");
    if (etag) {
      c.header("etag", etag);
      if (c.req.header("if-none-match") === etag) return c.body(null, 304);
    }

    let png: Uint8Array | null;
    try {
      const buf = readFileSync(path);
      png = plate ? extractPlateThumbnail(buf, plate) : extractThumbnail(buf);
    } catch {
      return c.json({ error: "could not read artifact" }, 404);
    }
    if (!png) return c.json({ error: "no thumbnail in artifact" }, 404);

    c.header("content-type", "image/png");
    return c.body(png as Uint8Array<ArrayBuffer>);
  });

  return app;
}
