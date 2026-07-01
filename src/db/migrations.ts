import type { Database } from "bun:sqlite";

export interface Migration {
  id: string;
  up: string;
}

// Ordered, append-only. Never edit a shipped migration — add a new one.
// Schema = spec ch4, with a few invariant-enforcing CHECKs added:
//   - stocker_state remaining in [0, capacity]  (INV-STOCKER-01 / INV-STOCKER-05)
//   - jobs.status / severity / policy constrained to their enums
export const MIGRATIONS: Migration[] = [
  {
    id: "0001_init",
    up: `
      CREATE TABLE projects (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        color_consistency_policy TEXT NOT NULL DEFAULT 'strict'
          CHECK (color_consistency_policy IN ('strict','propagate')),
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE jobs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id INTEGER REFERENCES projects(id),
        filename TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'processing'
          CHECK (status IN ('processing','queued','printing','success','failed','aborted','waiting_for_refill')),
        position INTEGER,
        attempts INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        thumbnail_path TEXT,
        mesh_json_path TEXT,
        filaments TEXT,
        ams_mapping TEXT,
        estimated_seconds INTEGER,
        substituted_slot INTEGER,
        substituted_color TEXT,
        filament_runout_policy_override TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE stocker_state (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        capacity INTEGER NOT NULL CHECK (capacity >= 0),
        remaining INTEGER NOT NULL CHECK (remaining >= 0 AND remaining <= capacity)
      );

      CREATE TABLE system_settings (
        key TEXT PRIMARY KEY,
        value TEXT
      );

      CREATE TABLE pending_actions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        type TEXT NOT NULL
          CHECK (type IN ('filament_confirm','stocker_refill','retry_decision','filament_runout','color_decision','mechanical_check')),
        job_id INTEGER REFERENCES jobs(id),
        project_id INTEGER REFERENCES projects(id),
        severity TEXT NOT NULL CHECK (severity IN ('blocking_queue','blocking_job','advisory')),
        message TEXT,
        snapshot_path TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        notified_at TEXT,
        resolved_at TEXT
      );

      CREATE INDEX idx_jobs_status ON jobs(status);
      CREATE INDEX idx_jobs_position ON jobs(position);
      CREATE INDEX idx_jobs_project ON jobs(project_id);
      CREATE INDEX idx_pending_unresolved ON pending_actions(resolved_at, project_id, type);
    `,
  },
];

/** Apply pending migrations in order. Idempotent. Returns the ids applied. */
export function migrate(db: Database): string[] {
  db.run("PRAGMA foreign_keys = ON");
  db.run(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
       id TEXT PRIMARY KEY,
       applied_at TEXT NOT NULL DEFAULT (datetime('now'))
     )`,
  );
  const applied = new Set(
    (db.query("SELECT id FROM schema_migrations").all() as { id: string }[]).map((r) => r.id),
  );

  const ran: string[] = [];
  for (const m of MIGRATIONS) {
    if (applied.has(m.id)) continue;
    const tx = db.transaction(() => {
      db.run(m.up);
      db.query("INSERT INTO schema_migrations (id) VALUES (?)").run(m.id);
    });
    tx();
    ran.push(m.id);
  }
  return ran;
}
