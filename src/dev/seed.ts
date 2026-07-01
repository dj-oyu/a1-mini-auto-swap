import type { Repo } from "../db/repo.ts";

/**
 * Populate a fresh Repo with a realistic, glanceable demo dataset for UI
 * development (spec 17 / docs/ui-handoff.md §2). Deterministic — no clock or
 * randomness — so the dev screens look identical on every boot and the seed can
 * be asserted in tests. Assumes an empty DB (a freshly migrated `:memory:` or a
 * throwaway file); it does not clear existing rows.
 *
 * The dataset intentionally spans every job status and a couple of pending
 * actions so the queue list, status badges, and the "対応待ち" banner all have
 * something real to render without a printer attached.
 */
export function seedDevDb(repo: Repo): void {
  // ── stocker: partially depleted so the header shows a non-trivial number ────
  repo.setStocker(8, 5);

  // ── projects: one of each color-consistency policy ──────────────────────────
  const fleet = repo.createProject("Benchy Fleet", "strict");
  const gridfinity = repo.createProject("Gridfinity Bins", "propagate");

  const filaments = (...colors: string[]) =>
    colors.map((color, i) => ({ slot: i + 1, color, type: "PLA" }));

  // ── currently printing (drives the live header + ETA) ───────────────────────
  const printing = repo.createJob({
    filename: "benchy_hull.gcode.3mf",
    project_id: fleet,
    estimated_seconds: 4500,
    filaments: filaments("#1f77b4"),
    ams_mapping: [0, -1, -1, -1],
  });
  repo.updateStatus(printing, "printing");

  // ── queued, filaments confirmed (the normal steady-state cards) ─────────────
  const q1 = repo.createJob({
    filename: "benchy_deck.gcode.3mf",
    project_id: fleet,
    estimated_seconds: 3900,
    filaments: filaments("#1f77b4"),
    ams_mapping: [0, -1, -1, -1],
  });
  repo.updateStatus(q1, "queued");

  const q2 = repo.createJob({
    filename: "gridfinity_2x2.gcode.3mf",
    project_id: gridfinity,
    estimated_seconds: 2700,
    filaments: filaments("#2ca02c", "#ff7f0e"),
    ams_mapping: [1, 2, -1, -1],
  });
  repo.updateStatus(q2, "queued");

  // ── processing: awaiting human filament confirmation (spec 17 hot path) ─────
  const processing = repo.createJob({
    filename: "gridfinity_baseplate.gcode.3mf",
    project_id: gridfinity,
    estimated_seconds: 5400,
    filaments: filaments("#2ca02c", "#ff7f0e"),
    ams_mapping: [-1, -1, -1, -1],
  });
  // left at the default 'processing' status; a filament_confirm pending backs it.

  // ── recently succeeded (with a silent color substitution to visualize) ──────
  const done = repo.createJob({
    filename: "benchy_chimney.gcode.3mf",
    project_id: fleet,
    estimated_seconds: 1800,
    filaments: filaments("#1f77b4"),
    ams_mapping: [0, -1, -1, -1],
  });
  repo.updateStatus(done, "success");
  repo.setSubstitution(done, 1, "#17becf"); // substituted color must stay visible

  // ── failed: awaiting a retry decision ───────────────────────────────────────
  const failed = repo.createJob({
    filename: "gridfinity_1x1.gcode.3mf",
    project_id: gridfinity,
    estimated_seconds: 900,
    filaments: filaments("#2ca02c"),
    ams_mapping: [1, -1, -1, -1],
  });
  repo.updateStatus(failed, "failed", "plate not detected after swap");
  repo.incrementAttempts(failed);

  // ── pending actions (the "対応待ち" queue — the UX centre) ───────────────────
  repo.createPendingAction({
    type: "filament_confirm",
    severity: "advisory",
    job_id: processing,
    project_id: gridfinity,
    message: "フィラメントとAMSマッピングを確認してください",
  });
  repo.createPendingAction({
    type: "retry_decision",
    severity: "blocking_job",
    job_id: failed,
    project_id: gridfinity,
    message: "plate not detected after swap",
  });
}
