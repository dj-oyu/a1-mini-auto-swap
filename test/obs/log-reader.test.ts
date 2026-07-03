import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readLogTail } from "../../src/obs/log-reader.ts";

// Deterministic: synthetic dated .jsonl files (no clock, no wall-clock waits).
// The reader is pure fs I/O; we control the bytes on disk.

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "log-reader-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** Write a dated app-*.jsonl with one record per `msgs` entry (append order). */
function writeFile(date: string, msgs: string[], prefix = "app"): void {
  const name = prefix ? `${prefix}-${date}.jsonl` : `${date}.jsonl`;
  const body = msgs.map((m, i) => JSON.stringify({ time: i, level: "info", msg: m })).join("\n") + "\n";
  writeFileSync(join(dir, name), body);
}

describe("readLogTail", () => {
  test("returns records NEWEST-FIRST (reverse of append order)", () => {
    writeFile("2026-07-03", ["a", "b", "c"]);
    const recs = readLogTail({ dir, prefix: "app", limit: 10 });
    expect(recs.map((r) => r.msg)).toEqual(["c", "b", "a"]);
  });

  test("respects the limit", () => {
    writeFile("2026-07-03", ["a", "b", "c", "d", "e"]);
    const recs = readLogTail({ dir, prefix: "app", limit: 2 });
    expect(recs.map((r) => r.msg)).toEqual(["e", "d"]);
  });

  test("spills into the previous dated file to reach the count (rotation)", () => {
    writeFile("2026-07-02", ["old1", "old2"]);
    writeFile("2026-07-03", ["new1", "new2"]);
    // Ask for 3: two from the newest file (newest-first), then one from the older.
    const recs = readLogTail({ dir, prefix: "app", limit: 3 });
    expect(recs.map((r) => r.msg)).toEqual(["new2", "new1", "old2"]);
  });

  test("does not read the older file when the newest already satisfies the count", () => {
    writeFile("2026-07-02", ["old1"]);
    writeFile("2026-07-03", ["new1", "new2"]);
    const recs = readLogTail({ dir, prefix: "app", limit: 2 });
    expect(recs.map((r) => r.msg)).toEqual(["new2", "new1"]);
  });

  test("tolerates a malformed trailing line (half-written record)", () => {
    writeFile("2026-07-03", ["a", "b"]);
    // Simulate a crash mid-append: a partial JSON line with no newline.
    appendFileSync(join(dir, "app-2026-07-03.jsonl"), '{"time":9,"level":"info","msg":"parti');
    const recs = readLogTail({ dir, prefix: "app", limit: 10 });
    // The two complete records survive; the trailing junk is dropped, not thrown.
    expect(recs.map((r) => r.msg)).toEqual(["b", "a"]);
  });

  test("tolerates a malformed line in the middle without dropping neighbours", () => {
    const name = join(dir, "app-2026-07-03.jsonl");
    writeFileSync(name, ['{"msg":"a"}', "NOT JSON", '{"msg":"c"}', ""].join("\n"));
    const recs = readLogTail({ dir, prefix: "app", limit: 10 });
    expect(recs.map((r) => r.msg)).toEqual(["c", "a"]);
  });

  test("missing directory → [] (never throws)", () => {
    expect(readLogTail({ dir: join(dir, "does-not-exist"), prefix: "app", limit: 10 })).toEqual([]);
  });

  test("empty directory → []", () => {
    expect(readLogTail({ dir, prefix: "app", limit: 10 })).toEqual([]);
  });

  test("is bounded: only the tail of a large file is read", () => {
    // 5000 records, but a 1 KiB window can only contain the last handful.
    const many = Array.from({ length: 5000 }, (_, i) => JSON.stringify({ time: i, msg: `m${i}` }));
    writeFileSync(join(dir, "app-2026-07-03.jsonl"), many.join("\n") + "\n");
    const recs = readLogTail({ dir, prefix: "app", limit: 5000, maxBytesPerFile: 1024, maxFiles: 1 });
    // Far fewer than 5000 came back (window-bounded), and they are the newest.
    expect(recs.length).toBeGreaterThan(0);
    expect(recs.length).toBeLessThan(200);
    expect(recs[0]!.msg).toBe("m4999");
  });

  test("empty prefix reads the raw recorder's YYYY-MM-DD.jsonl", () => {
    writeFile("2026-07-03", ["raw1", "raw2"], "");
    const recs = readLogTail({ dir, prefix: "", limit: 10 });
    expect(recs.map((r) => r.msg)).toEqual(["raw2", "raw1"]);
  });
});
