import { Hono } from "hono";
import type { Dispatcher } from "../core/dispatcher.ts";
import type { Repo } from "../db/repo.ts";
import type { ColorConsistencyPolicy } from "../db/types.ts";

function isValidPolicy(v: unknown): v is ColorConsistencyPolicy {
  return v === "strict" || v === "propagate";
}

/** Parse a route `:id` param the same way the read routes do (spec ch8):
 *  non-positive-integer ids are treated as "not found" rather than a 400,
 *  since they can never address a real row. */
function parseId(raw: string): number | null {
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) return null;
  return id;
}

/**
 * Write/mutation HTTP API over the SQLite Repo + Dispatcher (spec ch8).
 * Mirrors createApiApp's style: a plain Hono app, testable via
 * `app.request(...)`, mounted alongside the read routes by main().
 */
export function createWriteApp(deps: { repo: Repo; dispatcher: Dispatcher }): Hono {
  const { repo, dispatcher } = deps;
  const app = new Hono();

  // POST /api/projects — spec ch8: create a project.
  app.post("/api/projects", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      name?: unknown;
      color_consistency_policy?: unknown;
    };
    if (typeof body.name !== "string" || body.name.trim() === "") {
      return c.json({ error: "name is required" }, 400);
    }
    if (body.color_consistency_policy !== undefined && !isValidPolicy(body.color_consistency_policy)) {
      return c.json({ error: "invalid color_consistency_policy" }, 400);
    }
    const id = repo.createProject(
      body.name,
      body.color_consistency_policy as ColorConsistencyPolicy | undefined,
    );
    return c.json({ id }, 201);
  });

  // PATCH /api/projects/:id — spec ch8: toggle color consistency policy.
  app.patch("/api/projects/:id", async (c) => {
    const id = parseId(c.req.param("id"));
    if (id === null) return c.json({ error: "invalid project id" }, 404);
    const project = repo.getProject(id);
    if (!project) return c.json({ error: "project not found" }, 404);

    const body = (await c.req.json().catch(() => ({}))) as { color_consistency_policy?: unknown };
    if (!isValidPolicy(body.color_consistency_policy)) {
      return c.json({ error: "invalid color_consistency_policy" }, 400);
    }
    repo.setProjectPolicy(id, body.color_consistency_policy);
    return c.json(repo.getProject(id));
  });

  // POST /api/pending-actions/:id/resolve — spec ch8: human resolves a pending action.
  app.post("/api/pending-actions/:id/resolve", (c) => {
    const id = parseId(c.req.param("id"));
    if (id === null) return c.json({ error: "invalid pending action id" }, 404);
    const isUnresolved = repo.getUnresolvedPendingActions().some((a) => a.id === id);
    if (!isUnresolved) return c.json({ error: "pending action not found" }, 404);
    repo.resolvePendingAction(id);
    return c.json({ ok: true });
  });

  // POST /api/stocker/refill — spec ch8: human refills the stocker; also clears
  // any outstanding stocker_refill pending action(s) (INV-STOCKER-04).
  app.post("/api/stocker/refill", (c) => {
    const stocker = repo.getStocker();
    if (!stocker) return c.json({ error: "stocker not initialized" }, 404);
    repo.refillStocker();
    for (const action of repo.getUnresolvedPendingActions()) {
      if (action.type === "stocker_refill") repo.resolvePendingAction(action.id);
    }
    return c.json(repo.getStocker());
  });

  // POST /api/queue/:id/retry — spec ch8/18: human-triggered retry.
  app.post("/api/queue/:id/retry", async (c) => {
    const id = parseId(c.req.param("id"));
    if (id === null) return c.json({ error: "invalid job id" }, 404);
    if (!repo.getJob(id)) return c.json({ error: "job not found" }, 404);
    const requeued = await dispatcher.retry(id);
    return c.json({ requeued });
  });

  // DELETE /api/queue/:id — spec ch8: remove a job that isn't currently printing.
  app.delete("/api/queue/:id", (c) => {
    const id = parseId(c.req.param("id"));
    if (id === null) return c.json({ error: "invalid job id" }, 404);
    const job = repo.getJob(id);
    if (!job) return c.json({ error: "job not found" }, 404);
    if (job.status === "printing") {
      return c.json({ error: "cannot delete a job that is currently printing" }, 409);
    }
    repo.deleteJob(id);
    return c.body(null, 204);
  });

  return app;
}
