import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { MIGRATIONS, migrate } from "../../src/db/migrations.ts";
import { openDb } from "../../src/db/index.ts";

describe("migrations", () => {
  test("openDb creates all spec ch4 tables", () => {
    const { db, close } = openDb(":memory:");
    const tables = (
      db.query("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as {
        name: string;
      }[]
    ).map((r) => r.name);
    for (const t of ["projects", "jobs", "stocker_state", "system_settings", "pending_actions"]) {
      expect(tables).toContain(t);
    }
    close();
  });

  test("migrate is idempotent and records applied ids", () => {
    const db = new Database(":memory:");
    expect(migrate(db)).toEqual(["0001_init", "0002_selected_plate"]);
    expect(migrate(db)).toEqual([]); // second run applies nothing
    const applied = (db.query("SELECT id FROM schema_migrations").all() as { id: string }[]).map(
      (r) => r.id,
    );
    expect(applied).toEqual(["0001_init", "0002_selected_plate"]);
    db.close();
  });

  // Plate-selection (multi-plate 3mf upload): 0002_selected_plate must append
  // a nullable column to an EXISTING jobs table (a DB that already ran
  // 0001_init) without touching existing rows — append-only migration, no
  // down migration, no rewrite of 0001_init.
  test("0002_selected_plate adds a nullable column, applied idempotently to an existing DB", () => {
    const db = new Database(":memory:");
    // Simulate a DB that already ran 0001_init in a previous process (the
    // append-only contract: 0001_init itself is never touched by this change).
    db.run("PRAGMA foreign_keys = ON");
    db.run(
      `CREATE TABLE schema_migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT (datetime('now')))`,
    );
    db.run(MIGRATIONS[0]!.up);
    db.query("INSERT INTO schema_migrations (id) VALUES (?)").run(MIGRATIONS[0]!.id);
    const preExisting = db
      .query("INSERT INTO jobs (filename) VALUES ('legacy.gcode.3mf') RETURNING id")
      .get() as { id: number };

    // only the NEW migration runs — 0001_init is already recorded as applied
    expect(migrate(db)).toEqual(["0002_selected_plate"]);

    const cols = (db.query("PRAGMA table_info(jobs)").all() as { name: string }[]).map((c) => c.name);
    expect(cols).toContain("selected_plate");

    // the pre-existing row survived the ALTER TABLE with a NULL default
    const row = db.query("SELECT selected_plate FROM jobs WHERE id=?").get(preExisting.id) as {
      selected_plate: string | null;
    };
    expect(row.selected_plate).toBeNull();

    // a valid plate id can be written and round-trips
    db.query("UPDATE jobs SET selected_plate=? WHERE id=?").run("plate_24", preExisting.id);
    expect(
      (db.query("SELECT selected_plate FROM jobs WHERE id=?").get(preExisting.id) as { selected_plate: string }).selected_plate,
    ).toBe("plate_24");

    // re-running migrate is a no-op
    expect(migrate(db)).toEqual([]);
    db.close();
  });

  test("the selected_plate CHECK rejects a malformed value", () => {
    const db = new Database(":memory:");
    migrate(db);
    const id = (db.query("INSERT INTO jobs (filename) VALUES ('x.3mf') RETURNING id").get() as {
      id: number;
    }).id;
    expect(() => db.query("UPDATE jobs SET selected_plate=? WHERE id=?").run("not-a-plate", id)).toThrow();
    db.close();
  });
});

// First-boot regression: DB_PATH points into a directory that does not exist
// yet (e.g. ./data/orchestrator.sqlite on a fresh checkout). openDb must
// create the parent directory instead of dying with SQLITE_CANTOPEN.
import { openDb as openDbForBootstrap } from "../../src/db/index.ts";
import { existsSync, rmSync } from "node:fs";
import { join as joinPath } from "node:path";
import { tmpdir as osTmpdir } from "node:os";

test("openDb creates missing parent directories for a file-backed DB (first boot)", () => {
  const base = joinPath(osTmpdir(), `db-boot-${process.pid}-${Math.random().toString(36).slice(2)}`);
  const path = joinPath(base, "nested", "orchestrator.sqlite");
  try {
    const { repo, close } = openDbForBootstrap(path);
    repo.setStocker(10, 10);
    expect(repo.getStocker()!.capacity).toBe(10);
    close();
    expect(existsSync(path)).toBe(true);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
