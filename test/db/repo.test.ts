import { beforeEach, describe, expect, test } from "bun:test";
import { openDb, type Db } from "../../src/db/index.ts";
import type { Repo } from "../../src/db/repo.ts";

let dbh: Db;
let repo: Repo;

beforeEach(() => {
  dbh = openDb(":memory:");
  repo = dbh.repo;
});

describe("Repo — jobs", () => {
  test("createJob defaults to 'processing' and auto-increments position", () => {
    const a = repo.createJob({ filename: "a.3mf" });
    const b = repo.createJob({ filename: "b.3mf" });
    expect(repo.getJob(a)!.status).toBe("processing");
    expect(repo.getJob(a)!.position).toBe(1);
    expect(repo.getJob(b)!.position).toBe(2);
  });

  test("filaments and ams_mapping are stored as JSON", () => {
    const id = repo.createJob({
      filename: "x.3mf",
      ams_mapping: [-1, -1, 0, -1],
      filaments: [{ slot: 2, color: "#FF0000", type: "PLA" }],
    });
    const row = repo.getJob(id)!;
    expect(JSON.parse(row.ams_mapping!)).toEqual([-1, -1, 0, -1]);
    expect(JSON.parse(row.filaments!)[0].type).toBe("PLA");
  });

  test("updateStatus / listByStatus / incrementAttempts / setSubstitution", () => {
    const id = repo.createJob({ filename: "j.3mf" });
    repo.updateStatus(id, "queued");
    expect(repo.listByStatus("queued").map((j) => j.id)).toEqual([id]);
    repo.updateStatus(id, "failed", "boom");
    expect(repo.getJob(id)!.last_error).toBe("boom");
    repo.incrementAttempts(id);
    repo.incrementAttempts(id);
    expect(repo.getJob(id)!.attempts).toBe(2);
    repo.setSubstitution(id, 1, "#0000FF");
    expect(repo.getJob(id)!.substituted_color).toBe("#0000FF");
  });

  test("status CHECK rejects an invalid status", () => {
    const id = repo.createJob({ filename: "j.3mf" });
    expect(() =>
      dbh.db.query("UPDATE jobs SET status='bogus' WHERE id=?").run(id),
    ).toThrow();
  });

  test("listByStatus orders by position", () => {
    const a = repo.createJob({ filename: "a" });
    const b = repo.createJob({ filename: "b" });
    const c = repo.createJob({ filename: "c" });
    for (const id of [c, a, b]) repo.updateStatus(id, "queued");
    expect(repo.listByStatus("queued").map((j) => j.id)).toEqual([a, b, c]);
  });
});

describe("Repo — projects", () => {
  test("create/get/list with policy default strict", () => {
    const p = repo.createProject("proj");
    expect(repo.getProject(p)!.color_consistency_policy).toBe("strict");
    const p2 = repo.createProject("proj2", "propagate");
    expect(repo.getProject(p2)!.color_consistency_policy).toBe("propagate");
    expect(repo.listProjects().length).toBe(2);
  });

  test("policy CHECK rejects an invalid value", () => {
    expect(() =>
      dbh.db.query("INSERT INTO projects (name, color_consistency_policy) VALUES ('x','loose')").run(),
    ).toThrow();
  });
});

describe("Repo — stocker (INV-STOCKER-01 / INV-STOCKER-05 enforced by CHECK)", () => {
  test("set/get/decrement/refill", () => {
    repo.setStocker(10, 10);
    expect(repo.getStocker()!.remaining).toBe(10);
    repo.decrementStocker();
    expect(repo.getStocker()!.remaining).toBe(9);
    repo.refillStocker();
    expect(repo.getStocker()!.remaining).toBe(10);
  });

  test("remaining cannot go below 0 (decrement past 0 throws)", () => {
    repo.setStocker(1, 0);
    expect(() => repo.decrementStocker()).toThrow();
    expect(repo.getStocker()!.remaining).toBe(0);
  });

  test("remaining cannot exceed capacity", () => {
    expect(() => repo.setStocker(10, 11)).toThrow();
  });
});

describe("Repo — settings", () => {
  test("get returns null when unset; set then get; upsert overwrites", () => {
    expect(repo.getSetting("filament_runout_policy")).toBeNull();
    repo.setSetting("filament_runout_policy", "manual");
    expect(repo.getSetting("filament_runout_policy")).toBe("manual");
    repo.setSetting("filament_runout_policy", "allow_material_match");
    expect(repo.getSetting("filament_runout_policy")).toBe("allow_material_match");
  });
});

describe("Repo — pending actions", () => {
  test("create / getUnresolved / hasUnresolved / resolve", () => {
    const proj = repo.createProject("p");
    const id = repo.createPendingAction({
      type: "color_decision",
      severity: "blocking_job",
      project_id: proj,
      message: "decide",
    });
    expect(repo.getUnresolvedPendingActions().map((a) => a.id)).toEqual([id]);
    expect(repo.hasUnresolvedPendingAction(proj, "color_decision")).toBe(true);
    expect(repo.hasUnresolvedPendingAction(proj, "stocker_refill")).toBe(false);

    repo.resolvePendingAction(id);
    expect(repo.getUnresolvedPendingActions()).toEqual([]);
    expect(repo.hasUnresolvedPendingAction(proj, "color_decision")).toBe(false);
  });

  test("type/severity CHECKs reject invalid enums", () => {
    expect(() =>
      dbh.db.query("INSERT INTO pending_actions (type, severity) VALUES ('bogus','advisory')").run(),
    ).toThrow();
    expect(() =>
      dbh.db.query("INSERT INTO pending_actions (type, severity) VALUES ('color_decision','meh')").run(),
    ).toThrow();
  });
});

describe("Repo — reorderJobs (spec ch8)", () => {
  test("assigns positions 1..N in the given id order", () => {
    const a = repo.createJob({ filename: "a.3mf" });
    const b = repo.createJob({ filename: "b.3mf" });
    const c = repo.createJob({ filename: "c.3mf" });

    repo.reorderJobs([c, a, b]);

    expect(repo.getJob(c)!.position).toBe(1);
    expect(repo.getJob(a)!.position).toBe(2);
    expect(repo.getJob(b)!.position).toBe(3);
    // listJobs (ORDER BY position) now reflects the new order
    expect(repo.listJobs().map((j) => j.id)).toEqual([c, a, b]);
  });
});
