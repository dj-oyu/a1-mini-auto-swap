import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Hono } from "hono";
import { extractFilaments } from "../injection/threemf.ts";
import type { Repo } from "../db/repo.ts";

/**
 * Upload HTTP API over the SQLite Repo (spec ch8): `POST /api/queue` stores the
 * uploaded `.gcode.3mf` to the cache dir (consumed later by the orchestrator's
 * ArtifactResolver, see src/main.ts) and creates the corresponding job row.
 * Mirrors createApiApp/createWriteApp's style: a plain Hono app, testable via
 * `app.request(...)`, mounted alongside the other routes by main().
 */
export function createUploadApp(deps: { repo: Repo; cacheDir: string }): Hono {
  const { repo, cacheDir } = deps;
  const app = new Hono();

  // POST /api/queue?filename=... — spec ch8: 3mf/stlアップロード（②③開始）.
  // Body is the raw .gcode.3mf bytes (no multipart wrapper).
  app.post("/api/queue", async (c) => {
    const filename = c.req.query("filename");
    if (!filename) return c.json({ error: "filename query param is required" }, 400);

    const buf = Buffer.from(await c.req.arrayBuffer());
    if (buf.length === 0) return c.json({ error: "request body is empty" }, 400);

    let filaments;
    try {
      filaments = extractFilaments(buf);
    } catch {
      return c.json({ error: "invalid or corrupt .gcode.3mf archive" }, 400);
    }

    const id = repo.createJob({ filename, filaments });

    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(join(cacheDir, `${id}.gcode.3mf`), buf);

    return c.json({ id, filaments }, 201);
  });

  return app;
}
