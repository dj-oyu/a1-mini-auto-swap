import { Hono } from "hono";
import type { Repo } from "../db/repo.ts";

/**
 * Read-only HTTP API over the SQLite Repo (spec ch8). Returned as a Hono app
 * so it can be unit-tested via `app.request(...)` with no server/port, and
 * mounted alongside the write endpoints (added in later slices) by main().
 */
export function createApiApp(repo: Repo): Hono {
  const app = new Hono();

  // GET /api/queue — spec ch8: キュー一覧 (+ stocker残数 for the dashboard header)
  app.get("/api/queue", (c) => {
    return c.json({ jobs: repo.listJobs(), stocker: repo.getStocker() });
  });

  // GET /api/queue/:id — single job lookup
  app.get("/api/queue/:id", (c) => {
    const id = Number(c.req.param("id"));
    if (!Number.isInteger(id) || id <= 0) return c.json({ error: "invalid job id" }, 404);
    const job = repo.getJob(id);
    if (!job) return c.json({ error: "job not found" }, 404);
    return c.json(job);
  });

  // GET /api/pending-actions — spec ch8: 未解決の対応待ち一覧
  app.get("/api/pending-actions", (c) => {
    return c.json(repo.getUnresolvedPendingActions());
  });

  // GET /api/projects — spec ch8: プロジェクト一覧
  app.get("/api/projects", (c) => {
    return c.json(repo.listProjects());
  });

  // GET /api/stocker/status — spec ch8: ストッカー残数
  app.get("/api/stocker/status", (c) => {
    const stocker = repo.getStocker();
    if (!stocker) return c.json({ error: "stocker not initialized" }, 404);
    return c.json(stocker);
  });

  return app;
}
