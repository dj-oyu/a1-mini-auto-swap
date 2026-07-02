import { Hono } from "hono";
import { z } from "zod";
import type { Dispatcher } from "../core/dispatcher.ts";
import { isValidAmsMapping } from "../core/ams-mapping.ts";
import type { Repo } from "../db/repo.ts";

// ── request-body schemas (spec ch8) ─────────────────────────────────────────
// zod validates shape at the HTTP boundary; domain rules that also apply
// elsewhere (ams_mapping / INV-MQTT-01) live in core and are referenced here.

const policySchema = z.enum(["strict", "propagate"]);

const projectCreateSchema = z.object({
  name: z.string().refine((s) => s.trim() !== "", "name is required"),
  color_consistency_policy: policySchema.optional(),
});

const projectPatchSchema = z.object({
  color_consistency_policy: policySchema,
});

const filamentsPatchSchema = z.object({
  ams_mapping: z.custom<number[]>(isValidAmsMapping, {
    message: "ams_mapping must be a 4-element array of -1..3",
  }),
  filaments: z.array(z.unknown()).optional(),
  // undefined = leave as-is; null = unassign; number = must exist (checked vs DB below)
  project_id: z.number().int().nullish(),
  // Multi-plate 3mf upload: which Metadata/plate_N.gcode to print. undefined =
  // leave as-is (single-plate archives never send this).
  selected_plate: z
    .string()
    .regex(/^plate_\d+$/, "selected_plate must look like plate_<N>")
    .optional(),
});

const stockerSetSchema = z.object({
  capacity: z.number().int().min(1).max(100),
  remaining: z.number().int().min(0).max(100).optional(),
});

const reorderSchema = z.object({
  order: z
    .array(z.number().int().positive())
    .nonempty()
    .refine((a) => new Set(a).size === a.length, "order must not contain duplicate ids"),
});

type Parsed<T> = { ok: true; data: T } | { ok: false; error: string };

async function parseBody<T extends z.ZodType>(
  req: { json(): Promise<unknown> },
  schema: T,
): Promise<Parsed<z.infer<T>>> {
  const raw = await req.json().catch(() => null);
  const parsed = schema.safeParse(raw);
  if (parsed.success) return { ok: true, data: parsed.data };
  const issue = parsed.error.issues[0];
  return { ok: false, error: issue ? `${issue.path.join(".") || "body"}: ${issue.message}` : "invalid request body" };
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
/** Fire-and-forget queue kick after a mutation that could make a job
 *  dispatchable (confirm → queued, retry → queued, refill → unblocked). Never
 *  rejects into the request: dispatchNext no-ops when busy/blocked, and a
 *  failed start reverts the job to queued (dispatcher.dispatch). */
function triggerDispatch(dispatcher: Dispatcher): void {
  void dispatcher.dispatchNext().catch((e) => {
    console.warn(`[dispatch] start failed, job returned to queue: ${(e as Error).message}`);
  });
}

export function createWriteApp(deps: { repo: Repo; dispatcher: Dispatcher }): Hono {
  const { repo, dispatcher } = deps;
  const app = new Hono();

  // POST /api/stocker — set the stocker capacity (and reset remaining to it).
  // spec 11: capacity is a hardware-fixed value; this is how a fresh install
  // initializes it (there was previously no way to create the row from the UI).
  app.post("/api/stocker", async (c) => {
    const body = await parseBody(c.req, stockerSetSchema);
    if (!body.ok) return c.json({ error: body.error }, 400);
    repo.setStocker(body.data.capacity, body.data.remaining ?? body.data.capacity);
    // A newly-filled stocker may unblock a queue that stalled while empty.
    for (const a of repo.getUnresolvedPendingActions()) {
      if (a.type === "stocker_refill") repo.resolvePendingAction(a.id);
    }
    triggerDispatch(dispatcher);
    return c.json(repo.getStocker());
  });

  // POST /api/projects — spec ch8: create a project.
  app.post("/api/projects", async (c) => {
    const body = await parseBody(c.req, projectCreateSchema);
    if (!body.ok) return c.json({ error: body.error }, 400);
    const id = repo.createProject(body.data.name, body.data.color_consistency_policy);
    return c.json({ id }, 201);
  });

  // PATCH /api/projects/:id — spec ch8: toggle color consistency policy.
  app.patch("/api/projects/:id", async (c) => {
    const id = parseId(c.req.param("id"));
    if (id === null) return c.json({ error: "invalid project id" }, 404);
    const project = repo.getProject(id);
    if (!project) return c.json({ error: "project not found" }, 404);

    const body = await parseBody(c.req, projectPatchSchema);
    if (!body.ok) return c.json({ error: body.error }, 400);
    repo.setProjectPolicy(id, body.data.color_consistency_policy);
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
    triggerDispatch(dispatcher); // a refilled stocker may unblock the queue
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

    const body = await parseBody(c.req, filamentsPatchSchema);
    if (!body.ok) return c.json({ error: body.error }, 400);
    // project_id existence is a DB question, not a shape question — checked here.
    if (body.data.project_id != null && !repo.getProject(body.data.project_id)) {
      return c.json({ error: "project_id must be null or an existing project id" }, 400);
    }

    repo.setFilamentPlan(id, body.data.ams_mapping, body.data.filaments);
    if (body.data.project_id !== undefined) repo.setProject(id, body.data.project_id);
    if (body.data.selected_plate !== undefined) repo.setSelectedPlate(id, body.data.selected_plate);
    await dispatcher.enqueue(id); // processing → queued (spec ch6)
    for (const a of repo.getUnresolvedPendingActions()) {
      if (a.type === "filament_confirm" && a.job_id === id) repo.resolvePendingAction(a.id);
    }
    const queuedJob = repo.getJob(id);
    // Kick the queue: on an idle printer this starts the print now (spec ⑥ —
    // confirm → queued → dispatch). Fire-and-forget so the confirm returns
    // immediately (the FTPS upload takes seconds); dispatchNext no-ops if busy,
    // stocker-empty, or blocked, and a failed start reverts the job to queued.
    triggerDispatch(dispatcher);
    return c.json(queuedJob);
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
      triggerDispatch(dispatcher); // re-queued → start it if the printer is idle
    }
    return c.json({ requeued });
  });

  // PATCH /api/queue/reorder — spec ch8: set the queue order. Body { order:
  // number[] } lists all job ids in the desired order; positions become 1..N.
  app.patch("/api/queue/reorder", async (c) => {
    const body = await parseBody(c.req, reorderSchema);
    if (!body.ok) return c.json({ error: body.error }, 400);
    const ids = body.data.order;
    if (ids.some((id) => !repo.getJob(id))) {
      return c.json({ error: "order references a nonexistent job" }, 400);
    }
    repo.reorderJobs(ids);
    return c.json({ ok: true });
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
