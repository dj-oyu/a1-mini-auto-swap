import { describe, expect, test } from "bun:test";
import { openDb } from "../../src/db/index.ts";
import { seedDevDb } from "../../src/dev/seed.ts";
import type { JobStatus } from "../../src/db/types.ts";

/**
 * The dev harness (docs/ui-handoff.md §2) is only useful if its seed produces a
 * realistic dataset for the UI to render with no printer attached. These tests
 * pin that contract: every job status is represented, the stocker + projects are
 * set, and the "対応待ち" queue has something to show.
 */
describe("seedDevDb", () => {
  test("initializes the stocker as partially depleted", () => {
    const { repo } = openDb(":memory:");
    seedDevDb(repo);
    const stocker = repo.getStocker();
    expect(stocker).not.toBeNull();
    expect(stocker!.capacity).toBeGreaterThan(0);
    expect(stocker!.remaining).toBeGreaterThan(0);
    expect(stocker!.remaining).toBeLessThan(stocker!.capacity);
  });

  test("creates both color-consistency policies", () => {
    const { repo } = openDb(":memory:");
    seedDevDb(repo);
    const policies = repo.listProjects().map((p) => p.color_consistency_policy).sort();
    expect(policies).toEqual(["propagate", "strict"]);
  });

  test("represents every job status the UI must render", () => {
    const { repo } = openDb(":memory:");
    seedDevDb(repo);
    const present = new Set(repo.listJobs().map((j) => j.status));
    const required: JobStatus[] = ["processing", "queued", "printing", "success", "failed"];
    for (const status of required) {
      expect(present.has(status)).toBe(true);
    }
    // single-machine invariant: at most one printing job on the demo board
    expect(repo.listByStatus("printing").length).toBe(1);
  });

  test("the printing job carries an ETA and belongs to a project", () => {
    const { repo } = openDb(":memory:");
    seedDevDb(repo);
    const printing = repo.listByStatus("printing")[0];
    expect(printing).toBeDefined();
    expect(printing!.estimated_seconds).toBeGreaterThan(0);
    expect(printing!.project_id).not.toBeNull();
  });

  test("queued jobs have filaments and an ams_mapping for the confirm UI", () => {
    const { repo } = openDb(":memory:");
    seedDevDb(repo);
    for (const job of repo.listByStatus("queued")) {
      expect(job.filaments).not.toBeNull();
      const filaments = JSON.parse(job.filaments!) as unknown[];
      expect(filaments.length).toBeGreaterThan(0);
      expect(job.ams_mapping).not.toBeNull();
      expect(JSON.parse(job.ams_mapping!)).toHaveLength(4);
    }
  });

  test("a completed job keeps its substituted color visible (spec 14)", () => {
    const { repo } = openDb(":memory:");
    seedDevDb(repo);
    const substituted = repo.listByStatus("success").find((j) => j.substituted_color != null);
    expect(substituted).toBeDefined();
    expect(substituted!.substituted_slot).not.toBeNull();
  });

  test("populates the 対応待ち queue including a blocking action", () => {
    const { repo } = openDb(":memory:");
    seedDevDb(repo);
    const pending = repo.getUnresolvedPendingActions();
    expect(pending.length).toBeGreaterThanOrEqual(2);
    expect(pending.some((a) => a.type === "filament_confirm")).toBe(true);
    expect(pending.some((a) => a.severity === "blocking_job")).toBe(true);
    // every pending action deep-links to a job or project (spec 13)
    for (const a of pending) {
      expect(a.job_id != null || a.project_id != null).toBe(true);
    }
  });
});
