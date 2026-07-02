import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { migrate } from "./migrations.ts";
import { Repo } from "./repo.ts";

export { Repo } from "./repo.ts";
export { migrate, MIGRATIONS } from "./migrations.ts";
export type * from "./types.ts";

export interface Db {
  db: Database;
  repo: Repo;
  close(): void;
}

/**
 * Open (or create) the database at `path` (":memory:" for tests), run pending
 * migrations, and return the raw handle plus a typed Repo.
 */
export function openDb(path = ":memory:"): Db {
  // First boot: SQLite cannot create intermediate directories itself, so a
  // fresh checkout with DB_PATH=./data/... dies with SQLITE_CANTOPEN unless
  // the parent directory exists.
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.run("PRAGMA journal_mode = WAL");
  db.run("PRAGMA foreign_keys = ON");
  migrate(db);
  return { db, repo: new Repo(db), close: () => db.close() };
}
