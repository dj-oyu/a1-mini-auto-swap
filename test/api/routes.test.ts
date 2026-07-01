import { beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { createApiApp } from "../../src/api/routes.ts";
import { openDb, type Db } from "../../src/db/index.ts";
import type { Repo } from "../../src/db/repo.ts";
import type { JobRow, PendingActionRow, ProjectRow, StockerRow } from "../../src/db/types.ts";

let dbh: Db;
let repo: Repo;
let app: Hono;

beforeEach(() => {
  dbh = openDb(":memory:");
  repo = dbh.repo;
  app = createApiApp(repo);
});

describe("GET /api/queue (spec ch8)", () => {
  test("returns jobs (position order) and stocker together", async () => {
    const a = repo.createJob({ filename: "a.3mf" });
    const b = repo.createJob({ filename: "b.3mf" });
    const c = repo.createJob({ filename: "c.3mf" });
    // Reorder positions directly (a=3, b=1, c=2) so insertion order != position
    // order — this exercises the ORDER BY in Repo.listJobs rather than just
    // echoing back creation order.
    dbh.db.query("UPDATE jobs SET position=3 WHERE id=?").run(a);
    dbh.db.query("UPDATE jobs SET position=1 WHERE id=?").run(b);
    dbh.db.query("UPDATE jobs SET position=2 WHERE id=?").run(c);
    repo.setStocker(10, 7);

    const res = await app.request("/api/queue");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { jobs: JobRow[]; stocker: StockerRow | null };
    expect(body.jobs.map((j) => j.id)).toEqual([b, c, a]);
    expect(body.stocker).not.toBeNull();
    expect(body.stocker!.capacity).toBe(10);
    expect(body.stocker!.remaining).toBe(7);
  });

  test("stocker is null when never initialized", async () => {
    repo.createJob({ filename: "a.3mf" });
    const res = await app.request("/api/queue");
    const body = (await res.json()) as { jobs: JobRow[]; stocker: StockerRow | null };
    expect(body.stocker).toBeNull();
  });

  test("jobs is [] when the queue is empty", async () => {
    const res = await app.request("/api/queue");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { jobs: JobRow[]; stocker: StockerRow | null };
    expect(body.jobs).toEqual([]);
  });
});

describe("GET /api/queue/:id", () => {
  test("returns the job when it exists", async () => {
    const id = repo.createJob({ filename: "plate.3mf", estimated_seconds: 1200 });
    const res = await app.request(`/api/queue/${id}`);
    expect(res.status).toBe(200);
    const job = (await res.json()) as JobRow;
    expect(job.id).toBe(id);
    expect(job.filename).toBe("plate.3mf");
    expect(job.estimated_seconds).toBe(1200);
  });

  test("404s for a nonexistent (but valid) id", async () => {
    const res = await app.request("/api/queue/999999");
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(typeof body.error).toBe("string");
  });

  test("404s for a non-positive-integer id", async () => {
    for (const bad of ["0", "-1", "abc", "1.5"]) {
      const res = await app.request(`/api/queue/${bad}`);
      expect(res.status).toBe(404);
    }
  });
});

describe("GET /api/pending-actions", () => {
  test("only returns unresolved actions", async () => {
    const proj = repo.createProject("p1");
    const unresolvedId = repo.createPendingAction({
      type: "color_decision",
      severity: "blocking_job",
      project_id: proj,
      message: "pick a color",
    });
    const resolvedId = repo.createPendingAction({
      type: "stocker_refill",
      severity: "blocking_queue",
      message: "refill please",
    });
    repo.resolvePendingAction(resolvedId);

    const res = await app.request("/api/pending-actions");
    expect(res.status).toBe(200);
    const actions = (await res.json()) as PendingActionRow[];
    expect(actions.map((a) => a.id)).toEqual([unresolvedId]);
    expect(actions.every((a) => a.resolved_at === null)).toBe(true);
  });

  test("returns [] when there are no pending actions", async () => {
    const res = await app.request("/api/pending-actions");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });
});

describe("GET /api/projects", () => {
  test("returns projects with their color consistency policy", async () => {
    repo.createProject("strict-proj");
    repo.createProject("loose-proj", "propagate");

    const res = await app.request("/api/projects");
    expect(res.status).toBe(200);
    const projects = (await res.json()) as ProjectRow[];
    expect(projects.length).toBe(2);
    expect(projects.map((p) => p.name)).toEqual(["strict-proj", "loose-proj"]);
    expect(projects.find((p) => p.name === "loose-proj")!.color_consistency_policy).toBe("propagate");
  });
});

describe("GET /api/stocker/status", () => {
  test("returns the stocker row when set", async () => {
    repo.setStocker(20, 5);
    const res = await app.request("/api/stocker/status");
    expect(res.status).toBe(200);
    const stocker = (await res.json()) as StockerRow;
    expect(stocker.capacity).toBe(20);
    expect(stocker.remaining).toBe(5);
  });

  test("404s when the stocker has never been initialized", async () => {
    const res = await app.request("/api/stocker/status");
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(typeof body.error).toBe("string");
  });
});
