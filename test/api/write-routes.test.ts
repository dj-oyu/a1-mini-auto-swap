import { beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { createWriteApp } from "../../src/api/write-routes.ts";
import { Dispatcher } from "../../src/core/dispatcher.ts";
import type { PrinterPort } from "../../src/core/ports.ts";
import { openDb, type Db } from "../../src/db/index.ts";
import type { Repo } from "../../src/db/repo.ts";
import type { JobRow, ProjectRow, StockerRow } from "../../src/db/types.ts";

/** Minimal PrinterPort test double (spec ch8 write-routes only need Dispatcher
 *  to be constructible; no MQTT/FTPS I/O happens in these tests). */
class FakePrinter implements PrinterPort {
  async startPrint(_job: JobRow): Promise<void> {}
  async ejectAndReset(): Promise<void> {}
  async resumeWithAlternateSlot(_jobId: number, _slot: number): Promise<void> {}
}

let dbh: Db;
let repo: Repo;
let dispatcher: Dispatcher;
let app: Hono;

beforeEach(() => {
  dbh = openDb(":memory:");
  repo = dbh.repo;
  dispatcher = new Dispatcher(repo, new FakePrinter());
  app = createWriteApp({ repo, dispatcher });
});

describe("POST /api/projects (spec ch8)", () => {
  test("creates a project with default policy and returns its id", async () => {
    const res = await app.request("/api/projects", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "p1" }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: number };
    expect(typeof body.id).toBe("number");
    const project = repo.getProject(body.id);
    expect(project?.name).toBe("p1");
    expect(project?.color_consistency_policy).toBe("strict");
  });

  test("creates a project with an explicit policy", async () => {
    const res = await app.request("/api/projects", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "p2", color_consistency_policy: "propagate" }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: number };
    expect(repo.getProject(body.id)?.color_consistency_policy).toBe("propagate");
  });

  test("400s when name is missing", async () => {
    const res = await app.request("/api/projects", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(typeof body.error).toBe("string");
    expect(repo.listProjects()).toEqual([]);
  });

  test("400s when name is empty/whitespace", async () => {
    const res = await app.request("/api/projects", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "   " }),
    });
    expect(res.status).toBe(400);
    expect(repo.listProjects()).toEqual([]);
  });

  test("400s for an invalid policy", async () => {
    const res = await app.request("/api/projects", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "p3", color_consistency_policy: "bogus" }),
    });
    expect(res.status).toBe(400);
    expect(repo.listProjects()).toEqual([]);
  });
});

describe("PATCH /api/projects/:id", () => {
  test("updates the policy and returns the updated project row", async () => {
    const id = repo.createProject("p1", "strict");
    const res = await app.request(`/api/projects/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ color_consistency_policy: "propagate" }),
    });
    expect(res.status).toBe(200);
    const project = (await res.json()) as ProjectRow;
    expect(project.id).toBe(id);
    expect(project.color_consistency_policy).toBe("propagate");
    expect(repo.getProject(id)?.color_consistency_policy).toBe("propagate");
  });

  test("404s for a nonexistent project", async () => {
    const res = await app.request("/api/projects/999999", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ color_consistency_policy: "propagate" }),
    });
    expect(res.status).toBe(404);
  });

  test("404s for a non-positive-integer id", async () => {
    for (const bad of ["0", "-1", "abc", "1.5"]) {
      const res = await app.request(`/api/projects/${bad}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ color_consistency_policy: "propagate" }),
      });
      expect(res.status).toBe(404);
    }
  });

  test("400s for an invalid policy value and leaves the row (and DB CHECK) untouched", async () => {
    const id = repo.createProject("p1", "strict");
    const res = await app.request(`/api/projects/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ color_consistency_policy: "loose" }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(typeof body.error).toBe("string");
    // The route must reject before ever reaching the DB, so the CHECK-constrained
    // column stays at its prior value (proves we didn't rely on SQLite to 500 instead).
    expect(repo.getProject(id)?.color_consistency_policy).toBe("strict");
  });
});

describe("POST /api/pending-actions/:id/resolve", () => {
  test("resolves an unresolved pending action", async () => {
    const actionId = repo.createPendingAction({ type: "stocker_refill", severity: "blocking_queue" });
    const res = await app.request(`/api/pending-actions/${actionId}/resolve`, { method: "POST" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(repo.getUnresolvedPendingActions().map((a) => a.id)).not.toContain(actionId);
  });

  test("404s for an already-resolved action", async () => {
    const actionId = repo.createPendingAction({ type: "stocker_refill", severity: "blocking_queue" });
    repo.resolvePendingAction(actionId);
    const res = await app.request(`/api/pending-actions/${actionId}/resolve`, { method: "POST" });
    expect(res.status).toBe(404);
  });

  test("404s for a nonexistent action id", async () => {
    const res = await app.request("/api/pending-actions/999999/resolve", { method: "POST" });
    expect(res.status).toBe(404);
  });

  test("404s for a non-positive-integer id", async () => {
    for (const bad of ["0", "-1", "abc"]) {
      const res = await app.request(`/api/pending-actions/${bad}/resolve`, { method: "POST" });
      expect(res.status).toBe(404);
    }
  });
});

describe("POST /api/stocker/refill", () => {
  test("sets remaining=capacity and resolves outstanding stocker_refill pendings", async () => {
    repo.setStocker(10, 0);
    const refillAction = repo.createPendingAction({ type: "stocker_refill", severity: "blocking_queue" });
    // An unrelated pending action must be left alone.
    const otherAction = repo.createPendingAction({ type: "mechanical_check", severity: "advisory" });

    const res = await app.request("/api/stocker/refill", { method: "POST" });
    expect(res.status).toBe(200);
    const stocker = (await res.json()) as StockerRow;
    expect(stocker.remaining).toBe(10);
    expect(stocker.capacity).toBe(10);

    const unresolvedIds = repo.getUnresolvedPendingActions().map((a) => a.id);
    expect(unresolvedIds).not.toContain(refillAction);
    expect(unresolvedIds).toContain(otherAction);
  });

  test("404s when the stocker was never initialized", async () => {
    const res = await app.request("/api/stocker/refill", { method: "POST" });
    expect(res.status).toBe(404);
  });
});

describe("POST /api/queue/:id/retry", () => {
  test("requeues (requeued: true) when within the attempt cap", async () => {
    const id = repo.createJob({ filename: "a.3mf" });
    repo.updateStatus(id, "failed", "boom");
    const res = await app.request(`/api/queue/${id}/retry`, { method: "POST" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ requeued: true });
    expect(repo.getJob(id)?.status).toBe("queued");
  });

  test("resolves the job's retry_decision pending when it requeues", async () => {
    const id = repo.createJob({ filename: "a.3mf" });
    repo.updateStatus(id, "failed", "boom");
    const pid = repo.createPendingAction({ type: "retry_decision", severity: "blocking_job", job_id: id });
    expect(repo.getUnresolvedPendingActions().some((a) => a.id === pid)).toBe(true);

    await app.request(`/api/queue/${id}/retry`, { method: "POST" });
    expect(repo.getUnresolvedPendingActions().some((a) => a.id === pid)).toBe(false);
  });

  test("leaves the retry_decision pending when the retry cap is hit", async () => {
    const id = repo.createJob({ filename: "a.3mf" });
    repo.updateStatus(id, "failed", "boom");
    for (let i = 0; i < 4; i++) repo.incrementAttempts(id);
    const pid = repo.createPendingAction({ type: "retry_decision", severity: "blocking_job", job_id: id });

    const res = await app.request(`/api/queue/${id}/retry`, { method: "POST" });
    expect(await res.json()).toEqual({ requeued: false });
    expect(repo.getUnresolvedPendingActions().some((a) => a.id === pid)).toBe(true); // still needs a human
  });

  test("requeued: false once past the retry cap (default 3)", async () => {
    const id = repo.createJob({ filename: "a.3mf" });
    repo.updateStatus(id, "failed", "boom");
    for (let i = 0; i < 4; i++) repo.incrementAttempts(id); // attempts=4 > retryLimit(3)
    const res = await app.request(`/api/queue/${id}/retry`, { method: "POST" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ requeued: false });
    expect(repo.getJob(id)?.status).toBe("failed"); // untouched, not silently re-queued
  });

  test("404s for a nonexistent job", async () => {
    const res = await app.request("/api/queue/999999/retry", { method: "POST" });
    expect(res.status).toBe(404);
  });

  test("404s for a non-positive-integer id", async () => {
    for (const bad of ["0", "-1", "abc"]) {
      const res = await app.request(`/api/queue/${bad}/retry`, { method: "POST" });
      expect(res.status).toBe(404);
    }
  });
});

describe("DELETE /api/queue/:id", () => {
  test("204s and removes a queued job", async () => {
    const id = repo.createJob({ filename: "a.3mf" });
    repo.updateStatus(id, "queued");
    const res = await app.request(`/api/queue/${id}`, { method: "DELETE" });
    expect(res.status).toBe(204);
    expect(await res.text()).toBe("");
    expect(repo.getJob(id)).toBeNull();
  });

  test("409s for a job that is currently printing, and does not delete it", async () => {
    const id = repo.createJob({ filename: "a.3mf" });
    repo.updateStatus(id, "printing");
    const res = await app.request(`/api/queue/${id}`, { method: "DELETE" });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string };
    expect(typeof body.error).toBe("string");
    expect(repo.getJob(id)).not.toBeNull();
  });

  test("404s for a nonexistent job", async () => {
    const res = await app.request("/api/queue/999999", { method: "DELETE" });
    expect(res.status).toBe(404);
  });

  test("404s for a non-positive-integer id", async () => {
    for (const bad of ["0", "-1", "abc", "1.5"]) {
      const res = await app.request(`/api/queue/${bad}`, { method: "DELETE" });
      expect(res.status).toBe(404);
    }
  });
});

describe("POST /api/queue/:id/abort (spec ch8/19)", () => {
  test("aborts a printing job (aborted:true, status aborted)", async () => {
    repo.setStocker(10, 10);
    const id = repo.createJob({ filename: "a.3mf" });
    repo.updateStatus(id, "printing");
    const res = await app.request(`/api/queue/${id}/abort`, { method: "POST" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ aborted: true });
    expect(repo.getJob(id)?.status).toBe("aborted");
  });

  test("409s when the job is not printing", async () => {
    const id = repo.createJob({ filename: "a.3mf" });
    repo.updateStatus(id, "queued");
    const res = await app.request(`/api/queue/${id}/abort`, { method: "POST" });
    expect(res.status).toBe(409);
    expect(repo.getJob(id)?.status).toBe("queued");
  });

  test("404s for a missing or invalid id", async () => {
    expect((await app.request("/api/queue/999999/abort", { method: "POST" })).status).toBe(404);
    expect((await app.request("/api/queue/abc/abort", { method: "POST" })).status).toBe(404);
  });
});

describe("PATCH /api/queue/:id/filaments (spec ch8)", () => {
  const patch = (id: number | string, body: unknown) =>
    app.request(`/api/queue/${id}/filaments`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  test("confirms the plan: sets ams_mapping and moves processing→queued", async () => {
    const id = repo.createJob({ filename: "p.3mf", filaments: [{ slot: 1, color: "#111" }] });
    expect(repo.getJob(id)!.status).toBe("processing");

    const res = await patch(id, { ams_mapping: [0, 1, -1, -1] });
    expect(res.status).toBe(200);
    const job = (await res.json()) as JobRow;
    expect(job.status).toBe("queued");
    expect(JSON.parse(job.ams_mapping!)).toEqual([0, 1, -1, -1]);
  });

  test("optionally overwrites the filament list; omitting it keeps the stored one", async () => {
    const id = repo.createJob({ filename: "p.3mf", filaments: [{ slot: 1, color: "#111" }] });

    // omit filaments → unchanged
    await patch(id, { ams_mapping: [0, -1, -1, -1] });
    expect(JSON.parse(repo.getJob(id)!.filaments!)).toEqual([{ slot: 1, color: "#111" }]);

    // now edit them (job must be processing again to confirm; simulate a fresh one)
    const id2 = repo.createJob({ filename: "q.3mf", filaments: [{ slot: 1, color: "#111" }] });
    await patch(id2, { ams_mapping: [2, -1, -1, -1], filaments: [{ slot: 1, color: "#abc" }] });
    expect(JSON.parse(repo.getJob(id2)!.filaments!)).toEqual([{ slot: 1, color: "#abc" }]);
  });

  test("resolves the filament_confirm pending action for the job", async () => {
    const id = repo.createJob({ filename: "p.3mf" });
    const pid = repo.createPendingAction({
      type: "filament_confirm",
      severity: "advisory",
      job_id: id,
    });
    await patch(id, { ams_mapping: [0, -1, -1, -1] });
    expect(repo.getUnresolvedPendingActions().some((a) => a.id === pid)).toBe(false);
  });

  test("409s when the job is not processing (already queued/printing/etc.)", async () => {
    const id = repo.createJob({ filename: "p.3mf" });
    repo.updateStatus(id, "queued");
    const res = await patch(id, { ams_mapping: [0, -1, -1, -1] });
    expect(res.status).toBe(409);
    expect(repo.getJob(id)!.status).toBe("queued"); // unchanged
  });

  test("400s for a malformed ams_mapping", async () => {
    const id = repo.createJob({ filename: "p.3mf" });
    for (const bad of [[0, 1, 2], [0, 1, 2, 3, 4], [0, 1, 2, 9], "nope", [0, 1, 2, 1.5]]) {
      const res = await patch(id, { ams_mapping: bad });
      expect(res.status).toBe(400);
    }
    expect(repo.getJob(id)!.status).toBe("processing"); // still unconfirmed
  });

  test("400s when filaments is provided but not an array", async () => {
    const id = repo.createJob({ filename: "p.3mf" });
    const res = await patch(id, { ams_mapping: [0, -1, -1, -1], filaments: { nope: true } });
    expect(res.status).toBe(400);
  });

  test("404s for a missing or invalid id", async () => {
    expect((await patch(999999, { ams_mapping: [0, -1, -1, -1] })).status).toBe(404);
    expect((await patch("abc", { ams_mapping: [0, -1, -1, -1] })).status).toBe(404);
  });
});
