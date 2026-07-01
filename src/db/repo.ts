import type { Database } from "bun:sqlite";
import type { QueueStore } from "../core/ports.ts";
import type {
  ColorConsistencyPolicy,
  JobRow,
  JobStatus,
  PendingActionRow,
  PendingActionType,
  ProjectRow,
  Severity,
  StockerRow,
} from "./types.ts";

export interface CreateJobInput {
  filename: string;
  project_id?: number | null;
  estimated_seconds?: number | null;
  filaments?: unknown;
  ams_mapping?: number[];
}

export interface CreatePendingActionInput {
  type: PendingActionType;
  severity: Severity;
  job_id?: number | null;
  project_id?: number | null;
  message?: string | null;
}

/** Typed data-access over the SQLite schema (spec ch4). Thin, synchronous
 *  (bun:sqlite is sync); business rules live in the dispatcher (slice 3b). */
export class Repo implements QueueStore {
  constructor(private readonly db: Database) {}

  // ── projects ──────────────────────────────────────────────────────────────
  createProject(name: string, policy: ColorConsistencyPolicy = "strict"): number {
    const r = this.db
      .query("INSERT INTO projects (name, color_consistency_policy) VALUES (?,?) RETURNING id")
      .get(name, policy) as { id: number };
    return r.id;
  }
  getProject(id: number): ProjectRow | null {
    return this.db.query("SELECT * FROM projects WHERE id=?").get(id) as ProjectRow | null;
  }
  listProjects(): ProjectRow[] {
    return this.db.query("SELECT * FROM projects ORDER BY id").all() as ProjectRow[];
  }
  // spec ch8: write endpoint for PATCH /api/projects/:id (color consistency policy toggle).
  setProjectPolicy(id: number, policy: ColorConsistencyPolicy): void {
    this.db
      .query("UPDATE projects SET color_consistency_policy=?, updated_at=datetime('now') WHERE id=?")
      .run(policy, id);
  }

  // ── jobs ──────────────────────────────────────────────────────────────────
  createJob(input: CreateJobInput): number {
    const pos = (
      this.db.query("SELECT COALESCE(MAX(position),0)+1 AS p FROM jobs").get() as { p: number }
    ).p;
    const r = this.db
      .query(
        `INSERT INTO jobs (filename, project_id, estimated_seconds, filaments, ams_mapping, position)
         VALUES (?,?,?,?,?,?) RETURNING id`,
      )
      .get(
        input.filename,
        input.project_id ?? null,
        input.estimated_seconds ?? null,
        input.filaments != null ? JSON.stringify(input.filaments) : null,
        input.ams_mapping != null ? JSON.stringify(input.ams_mapping) : null,
        pos,
      ) as { id: number };
    return r.id;
  }
  getJob(id: number): JobRow | null {
    return this.db.query("SELECT * FROM jobs WHERE id=?").get(id) as JobRow | null;
  }
  listJobs(): JobRow[] {
    return this.db.query("SELECT * FROM jobs ORDER BY position ASC, id ASC").all() as JobRow[];
  }
  listByStatus(status: JobStatus): JobRow[] {
    return this.db
      .query("SELECT * FROM jobs WHERE status=? ORDER BY position ASC, id ASC")
      .all(status) as JobRow[];
  }
  updateStatus(id: number, status: JobStatus, lastError: string | null = null): void {
    this.db
      .query("UPDATE jobs SET status=?, last_error=?, updated_at=datetime('now') WHERE id=?")
      .run(status, lastError, id);
  }
  incrementAttempts(id: number): void {
    this.db.query("UPDATE jobs SET attempts=attempts+1, updated_at=datetime('now') WHERE id=?").run(id);
  }
  setSubstitution(id: number, slot: number, color: string): void {
    this.db
      .query("UPDATE jobs SET substituted_slot=?, substituted_color=?, updated_at=datetime('now') WHERE id=?")
      .run(slot, color, id);
  }
  // spec ch8: confirm/adjust the filament plan (PATCH /api/queue/:id/filaments).
  // Sets the AMS mapping (and optionally an edited filament list) without
  // changing status — the caller transitions processing→queued. A null
  // filaments arg leaves the stored list untouched (COALESCE).
  setFilamentPlan(id: number, amsMapping: number[], filaments?: unknown): void {
    this.db
      .query(
        `UPDATE jobs SET ams_mapping=?, filaments=COALESCE(?, filaments), updated_at=datetime('now') WHERE id=?`,
      )
      .run(
        JSON.stringify(amsMapping),
        filaments != null ? JSON.stringify(filaments) : null,
        id,
      );
  }
  // spec ch8: write endpoint for DELETE /api/queue/:id (remove a non-active job).
  deleteJob(id: number): void {
    this.db.query("DELETE FROM jobs WHERE id=?").run(id);
  }

  // ── stocker ───────────────────────────────────────────────────────────────
  setStocker(capacity: number, remaining: number): void {
    this.db
      .query(
        `INSERT INTO stocker_state (id, capacity, remaining) VALUES (1,?,?)
         ON CONFLICT(id) DO UPDATE SET capacity=excluded.capacity, remaining=excluded.remaining`,
      )
      .run(capacity, remaining);
  }
  getStocker(): StockerRow | null {
    return this.db.query("SELECT * FROM stocker_state WHERE id=1").get() as StockerRow | null;
  }
  /** Decrement on swap. Throws (CHECK remaining>=0) if it would go negative. */
  decrementStocker(): void {
    this.db.query("UPDATE stocker_state SET remaining=remaining-1 WHERE id=1").run();
  }
  refillStocker(): void {
    this.db.query("UPDATE stocker_state SET remaining=capacity WHERE id=1").run();
  }

  // ── system settings ───────────────────────────────────────────────────────
  getSetting(key: string): string | null {
    const r = this.db.query("SELECT value FROM system_settings WHERE key=?").get(key) as
      | { value: string | null }
      | null;
    return r ? r.value : null;
  }
  setSetting(key: string, value: string): void {
    this.db
      .query(
        `INSERT INTO system_settings (key, value) VALUES (?,?)
         ON CONFLICT(key) DO UPDATE SET value=excluded.value`,
      )
      .run(key, value);
  }

  // ── pending actions ───────────────────────────────────────────────────────
  createPendingAction(input: CreatePendingActionInput): number {
    const r = this.db
      .query(
        `INSERT INTO pending_actions (type, severity, job_id, project_id, message)
         VALUES (?,?,?,?,?) RETURNING id`,
      )
      .get(
        input.type,
        input.severity,
        input.job_id ?? null,
        input.project_id ?? null,
        input.message ?? null,
      ) as { id: number };
    return r.id;
  }
  getUnresolvedPendingActions(): PendingActionRow[] {
    return this.db
      .query("SELECT * FROM pending_actions WHERE resolved_at IS NULL ORDER BY id")
      .all() as PendingActionRow[];
  }
  hasUnresolvedPendingAction(projectId: number, type: PendingActionType): boolean {
    const r = this.db
      .query(
        "SELECT 1 FROM pending_actions WHERE project_id=? AND type=? AND resolved_at IS NULL LIMIT 1",
      )
      .get(projectId, type);
    return r != null;
  }
  resolvePendingAction(id: number): void {
    this.db
      .query("UPDATE pending_actions SET resolved_at=datetime('now') WHERE id=? AND resolved_at IS NULL")
      .run(id);
  }
}
