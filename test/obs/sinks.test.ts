import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Clock } from "../../src/core/ports.ts";
import {
  ConsoleSink,
  MemorySink,
  RotatingFileSink,
  isoDate,
} from "../../src/obs/sinks.ts";

const DAY = 86_400_000;

describe("MemorySink", () => {
  test("captures lines (newline-trimmed) and parses them back", () => {
    const mem = new MemorySink();
    mem.write('{"a":1}\n');
    mem.write('{"a":2}'); // no trailing newline
    expect(mem.lines).toEqual(['{"a":1}', '{"a":2}']);
    expect(mem.records()).toEqual([{ a: 1 }, { a: 2 }]);
  });

  test("clear() empties the buffer", () => {
    const mem = new MemorySink();
    mem.write('{"a":1}\n');
    mem.clear();
    expect(mem.lines).toEqual([]);
  });
});

describe("isoDate", () => {
  test("maps epoch-ms to a UTC YYYY-MM-DD key", () => {
    expect(isoDate(Date.parse("2026-07-03T12:34:56Z"))).toBe("2026-07-03");
  });
});

describe("RotatingFileSink", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "obs-rot-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("writes to a date-stamped filename from the injected clock", () => {
    const clock: Clock = { now: () => Date.parse("2026-07-03T10:00:00Z") };
    const sink = new RotatingFileSink({ dir, prefix: "app", clock });
    sink.write('{"msg":"hi"}\n');
    const file = join(dir, "app-2026-07-03.jsonl");
    expect(existsSync(file)).toBe(true);
    expect(readFileSync(file, "utf8")).toBe('{"msg":"hi"}\n');
  });

  test("empty prefix uses just the date as the filename", () => {
    const clock: Clock = { now: () => Date.parse("2026-07-03T10:00:00Z") };
    const sink = new RotatingFileSink({ dir, prefix: "", clock });
    sink.write("raw\n");
    expect(existsSync(join(dir, "2026-07-03.jsonl"))).toBe(true);
  });

  test("rolls over to a new file when the clock crosses a day boundary", () => {
    let now = Date.parse("2026-07-03T23:59:00Z");
    const clock: Clock = { now: () => now };
    const sink = new RotatingFileSink({ dir, prefix: "app", clock, retentionDays: 0 });
    sink.write("day1\n");
    now = Date.parse("2026-07-04T00:01:00Z");
    sink.write("day2\n");
    expect(existsSync(join(dir, "app-2026-07-03.jsonl"))).toBe(true);
    expect(existsSync(join(dir, "app-2026-07-04.jsonl"))).toBe(true);
  });

  test("prunes files older than retentionDays on rollover (driven by FakeClock)", () => {
    let now = Date.parse("2026-07-01T10:00:00Z");
    const clock: Clock = { now: () => now };
    const sink = new RotatingFileSink({ dir, prefix: "app", clock, retentionDays: 2 });
    // Seed some rotated files by advancing the clock across days.
    sink.write("d1\n"); // app-2026-07-01
    now = Date.parse("2026-07-02T10:00:00Z");
    sink.write("d2\n"); // app-2026-07-02
    now = Date.parse("2026-07-03T10:00:00Z");
    sink.write("d3\n"); // app-2026-07-03 → cutoff 07-01: nothing older, all kept
    expect(readdirSync(dir).sort()).toEqual([
      "app-2026-07-01.jsonl",
      "app-2026-07-02.jsonl",
      "app-2026-07-03.jsonl",
    ]);
    now = Date.parse("2026-07-04T10:00:00Z");
    sink.write("d4\n"); // app-2026-07-04 → cutoff 07-02; 07-01 (< cutoff) pruned
    const files = readdirSync(dir).sort();
    expect(files).toEqual([
      "app-2026-07-02.jsonl",
      "app-2026-07-03.jsonl",
      "app-2026-07-04.jsonl",
    ]);
  });

  test("retentionDays<=0 disables pruning", () => {
    let now = Date.parse("2026-01-01T10:00:00Z");
    const clock: Clock = { now: () => now };
    const sink = new RotatingFileSink({ dir, prefix: "app", clock, retentionDays: 0 });
    sink.write("old\n");
    now = Date.parse("2026-07-03T10:00:00Z");
    sink.write("new\n");
    const files = readdirSync(dir).sort();
    expect(files).toEqual(["app-2026-01-01.jsonl", "app-2026-07-03.jsonl"]);
  });

  test("only prunes files matching this sink's prefix (leaves foreign files)", () => {
    let now = Date.parse("2026-07-01T10:00:00Z");
    const clock: Clock = { now: () => now };
    // A foreign, very old file that must survive because the prefix differs.
    writeFileSync(join(dir, "state-2026-01-01.jsonl"), "keep\n");
    const sink = new RotatingFileSink({ dir, prefix: "app", clock, retentionDays: 2 });
    sink.write("d1\n");
    now = Date.parse("2026-07-05T10:00:00Z");
    sink.write("d5\n");
    expect(existsSync(join(dir, "state-2026-01-01.jsonl"))).toBe(true);
  });
});

describe("ConsoleSink", () => {
  test("json format emits the raw line verbatim (newline ensured)", () => {
    const out: string[] = [];
    const sink = new ConsoleSink("json", (s) => out.push(s));
    sink.write('{"level":"info","msg":"hi"}');
    expect(out).toEqual(['{"level":"info","msg":"hi"}\n']);
  });

  test("pretty format reparses into a compact human line", () => {
    const out: string[] = [];
    const sink = new ConsoleSink("pretty", (s) => out.push(s));
    const line = JSON.stringify({
      time: Date.parse("2026-07-03T12:34:56.789Z"),
      level: "warn",
      mod: "ftps",
      msg: "upload failed",
      file: "x.3mf",
    });
    sink.write(line);
    const rendered = out[0]!;
    expect(rendered).toContain("12:34:56.789");
    expect(rendered).toContain("WARN");
    expect(rendered).toContain("[ftps]");
    expect(rendered).toContain("upload failed");
    expect(rendered).toContain("file=x.3mf");
    expect(rendered.endsWith("\n")).toBe(true);
  });

  test("pretty format falls back to the raw line for unparseable input", () => {
    const out: string[] = [];
    const sink = new ConsoleSink("pretty", (s) => out.push(s));
    sink.write("not json");
    expect(out).toEqual(["not json\n"]);
  });
});
