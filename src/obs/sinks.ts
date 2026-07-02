import { appendFileSync, mkdirSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import type { Clock } from "../core/ports.ts";
import { systemClock } from "../core/ports.ts";

// Log sinks (pino destinations). A sink is anything with `write(line)`, matching
// pino's DestinationStream contract, so it drops straight into pino.multistream.
// All sinks here are pure JS + synchronous fs — NO worker-thread transports,
// which are unstable under Bun (see obs/logger.ts). pino serializes each record
// to a JSON line ending in "\n"; sinks receive that line verbatim.

export interface LogSink {
  write(line: string): void;
}

/** UTC calendar date (YYYY-MM-DD) for a given epoch-ms — the daily-rotation key. */
export function isoDate(epochMs: number): string {
  return new Date(epochMs).toISOString().slice(0, 10);
}

/** In-memory sink for deterministic tests: keeps every written line and can
 *  parse them back into records. */
export class MemorySink implements LogSink {
  readonly lines: string[] = [];
  write(line: string): void {
    // pino appends "\n"; store trimmed so tests compare clean lines.
    this.lines.push(line.endsWith("\n") ? line.slice(0, -1) : line);
  }
  /** Parsed JSON records (one per line). */
  records(): Array<Record<string, unknown>> {
    return this.lines.map((l) => JSON.parse(l) as Record<string, unknown>);
  }
  clear(): void {
    this.lines.length = 0;
  }
}

export interface RotatingFileSinkOptions {
  /** Directory the files live in (created if missing). */
  dir: string;
  /** Filename prefix, e.g. "app" → app-2026-07-03.jsonl. Empty → 2026-07-03.jsonl
   *  (used by the raw MQTT recorder). */
  prefix?: string;
  clock?: Clock;
  /** Delete rotated files older than this many days on each day-rollover.
   *  0 (or negative) disables pruning. Default 14. */
  retentionDays?: number;
}

/**
 * Daily-rotating JSONL file sink. The filename's date comes from the injected
 * Clock, so rotation is fully deterministic in tests (advance the clock across a
 * day boundary → a new file). Uses synchronous `appendFileSync`, so a line is on
 * disk the instant it's logged (low-volume streams; a test can read it right
 * back). On each rollover it prunes files older than `retentionDays`.
 */
export class RotatingFileSink implements LogSink {
  private readonly dir: string;
  private readonly prefix: string;
  private readonly clock: Clock;
  private readonly retentionDays: number;
  private currentDate = "";

  constructor(opts: RotatingFileSinkOptions) {
    this.dir = opts.dir;
    this.prefix = opts.prefix ?? "";
    this.clock = opts.clock ?? systemClock;
    this.retentionDays = opts.retentionDays ?? 14;
    mkdirSync(this.dir, { recursive: true });
  }

  private fileName(date: string): string {
    return this.prefix ? `${this.prefix}-${date}.jsonl` : `${date}.jsonl`;
  }

  write(line: string): void {
    const date = isoDate(this.clock.now());
    if (date !== this.currentDate) {
      this.currentDate = date;
      this.prune(date);
    }
    appendFileSync(join(this.dir, this.fileName(date)), line.endsWith("\n") ? line : line + "\n");
  }

  /** Delete `${prefix}-YYYY-MM-DD.jsonl` files older than the retention window. */
  private prune(today: string): void {
    if (this.retentionDays <= 0) return;
    const cutoff = Date.parse(today + "T00:00:00Z") - this.retentionDays * 86_400_000;
    const re = this.prefix
      ? new RegExp(`^${escapeRe(this.prefix)}-(\\d{4}-\\d{2}-\\d{2})\\.jsonl$`)
      : /^(\d{4}-\d{2}-\d{2})\.jsonl$/;
    let entries: string[];
    try {
      entries = readdirSync(this.dir);
    } catch {
      return;
    }
    for (const name of entries) {
      const m = re.exec(name);
      if (!m || !m[1]) continue;
      const fileMs = Date.parse(m[1] + "T00:00:00Z");
      if (Number.isFinite(fileMs) && fileMs < cutoff) {
        try {
          unlinkSync(join(this.dir, name));
        } catch {
          // best-effort: a file we can't delete must never break logging
        }
      }
    }
  }
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export type ConsoleFormat = "json" | "pretty";

/**
 * Console sink. `json` writes the raw pino line (machine-readable). `pretty`
 * reparses each line into a compact human line — a self-contained formatter, so
 * we avoid pino-pretty's worker-thread transport (unstable under Bun). Falls
 * back to the raw line if a record can't be parsed.
 */
export class ConsoleSink implements LogSink {
  constructor(
    private readonly format: ConsoleFormat,
    private readonly out: (s: string) => void = (s) => void process.stdout.write(s),
  ) {}

  write(line: string): void {
    if (this.format === "json") {
      this.out(line.endsWith("\n") ? line : line + "\n");
      return;
    }
    this.out(formatPretty(line));
  }
}

function formatPretty(line: string): string {
  let rec: Record<string, unknown>;
  try {
    rec = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return line.endsWith("\n") ? line : line + "\n";
  }
  const time = typeof rec.time === "number" ? new Date(rec.time).toISOString().slice(11, 23) : "--:--:--.---";
  const level = String(rec.level ?? "info").toUpperCase().padEnd(5);
  const mod = typeof rec.mod === "string" ? ` [${rec.mod}]` : "";
  const msg = typeof rec.msg === "string" ? rec.msg : "";
  const skip = new Set(["time", "level", "msg", "mod"]);
  const extras = Object.entries(rec)
    .filter(([k]) => !skip.has(k))
    .map(([k, v]) => `${k}=${scalar(v)}`);
  const tail = extras.length ? "  " + extras.join(" ") : "";
  return `${time} ${level}${mod} ${msg}${tail}\n`;
}

function scalar(v: unknown): string {
  if (v === null || v === undefined) return String(v);
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}
