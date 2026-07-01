import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { migrate } from "../../src/db/migrations.ts";
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
    expect(migrate(db)).toEqual(["0001_init"]);
    expect(migrate(db)).toEqual([]); // second run applies nothing
    const applied = (db.query("SELECT id FROM schema_migrations").all() as { id: string }[]).map(
      (r) => r.id,
    );
    expect(applied).toEqual(["0001_init"]);
    db.close();
  });
});
