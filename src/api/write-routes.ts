import { Hono } from "hono";
import type { Dispatcher } from "../core/dispatcher.ts";
import type { Repo } from "../db/repo.ts";
import type { ColorConsistencyPolicy } from "../db/types.ts";

function isValidPolicy(v: unknown): v is ColorConsistencyPolicy {
  return v === "strict" || v === "propagate";
}

/** An AMS mapping is a 4-element array (one entry per print slot) whose values
 *  are tray indices 0–3, or -1 for "unused" (spec ch8/14). */
function isValidAmsMapping(v: unknown): v is number[] {
  return (
    Array.isArray(v) &&
    v.length === 4 &&
    v.every((n) => Number.isInteger(n) && n >= -1 && n <= 3)
  );
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

  // PATCH /api/queue/:id/filaments — spec ch8: confirm the filament plan for a
  // processing job (the upload confirm step, spec 17 §6). Sets the AMS mapping
  // (+ optional edited filament list), resolves the filament_confirm pending,
  // and transitions processing→queued. Only valid while the job is 'processing'.
  app.patch("/api/queue/:id/filaments", async (c) => {
    const id = parseId(c.req.param("id"));
    if (id === null) return c.json({ error: "invalid job id" }, 404);
    const job = repo.getJob(id);
    if (!job) return c.json({ error: "job not found" }, 404);
    if (job.status !== "processing") {
      return c.json({ error: "filaments can only be confirmed while processing" }, 409);
    }

    const body = (await c.req.json().catch(() => ({}))) as {
      ams_mapping?: unknown;
      filaments?: unknown;
      project_id?: unknown;
    };
    if (!isValidAmsMapping(body.ams_mapping)) {
      return c.json({ error: "ams_mapping must be a 4-element array of -1..3" }, 400);
    }
    if (body.filaments !== undefined && !Array.isArray(body.filaments)) {
      return c.json({ error: "filaments must be an array when provided" }, 400);
    }
    // project_id: undefined = leave as-is; null = unassign; number = must exist.
    if (
      body.project_id !== undefined &&
      body.project_id !== null &&
      (!Number.isInteger(body.project_id) || !repo.getProject(body.project_id as number))
    ) {
      return c.json({ error: "project_id must be null or an existing project id" }, 400);
    }

    repo.setFilamentPlan(id, body.ams_mapping, body.filaments);
    if (body.project_id !== undefined) repo.setProject(id, body.project_id as number | null);
    await dispatcher.enqueue(id); // processing → queued (spec ch6)
    for (const a of repo.getUnresolvedPendingActions()) {
      if (a.type === "filament_confirm" && a.job_id === id) repo.resolvePendingAction(a.id);
    }
    return c.json(repo.getJob(id));
  });

  // POST /api/queue/:id/retry — spec ch8/18: human-triggered retry.
  app.post("/api/queue/:id/retry", async (c) => {
    const id = parseId(c.req.param("id"));
    if (id === null) return c.json({ error: "invalid job id" }, 404);
    if (!repo.getJob(id)) return c.json({ error: "job not found" }, 404);
    const requeued = await dispatcher.retry(id);
    // The human has decided: clear the job's retry_decision pending so it doesn't
    // linger in 対応待ち after the job is re-queued.
    if (requeued) {
      for (const a of repo.getUnresolvedPendingActions()) {
        if (a.type === "retry_decision" && a.job_id === id) repo.resolvePendingAction(a.id);
      }
    }
    return c.json({ requeued });
  });

  // POST /api/queue/:id/abort — spec ch8/19: stop the running plate (eject/reset,
  // swap, auto-advance). 409 if the job isn't currently printing.
  app.post("/api/queue/:id/abort", async (c) => {
    const id = parseId(c.req.param("id"));
    if (id === null) return c.json({ error: "invalid job id" }, 404);
    const job = repo.getJob(id);
    if (!job) return c.json({ error: "job not found" }, 404);
    if (job.status !== "printing") {
      return c.json({ error: "only a printing job can be aborted" }, 409);
    }
    const aborted = await dispatcher.abort(id);
    return c.json({ aborted });
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
