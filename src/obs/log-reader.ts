import { closeSync, fstatSync, openSync, readdirSync, readSync } from "node:fs";
import { join } from "node:path";

// Bounded log reader (obs, read side). The audit streams are daily-rotating
// JSONL files (obs/sinks.ts). To surface the recent tail in the UI without ever
// loading a whole day's file into memory, this reads only the LAST few KB of the
// newest dated file (and spills into the previous day only if needed to reach the
// requested count), parses each line as JSON NEWEST-FIRST, and tolerates a
// malformed/partial line (a truncated head after the byte-window cut, or a
// half-written trailing line). A missing/empty directory yields [] — never throws.
//
// This is an adapter (fs I/O): it holds no domain logic, just tails files.

export interface LogReaderOptions {
  /** Directory the dated files live in. */
  dir: string;
  /** Filename prefix: "app" → app-YYYY-MM-DD.jsonl, "state" → state-…, or "" for
   *  the raw recorder's YYYY-MM-DD.jsonl. */
  prefix: string;
  /** Max parsed records to return (newest-first). */
  limit: number;
  /** Bytes to read from the tail of each file (default 256 KiB). Bounds memory. */
  maxBytesPerFile?: number;
  /** How many dated files to spill across when the newest is too small (default 3). */
  maxFiles?: number;
}

const DEFAULT_MAX_BYTES = 256 * 1024;
const DEFAULT_MAX_FILES = 3;

/** Read the newest N records (newest-first) across the most recent dated files. */
export function readLogTail(opts: LogReaderOptions): Array<Record<string, unknown>> {
  const maxBytes = opts.maxBytesPerFile ?? DEFAULT_MAX_BYTES;
  const maxFiles = opts.maxFiles ?? DEFAULT_MAX_FILES;
  const limit = Math.max(0, opts.limit | 0);
  if (limit === 0) return [];

  const out: Array<Record<string, unknown>> = [];
  const files = datedFiles(opts.dir, opts.prefix); // newest-first
  for (const name of files.slice(0, maxFiles)) {
    if (out.length >= limit) break;
    const recs = readTailFile(join(opts.dir, name), maxBytes); // file order (oldest→newest)
    // Newest-first within the file, then move to the older file if still short.
    for (let i = recs.length - 1; i >= 0 && out.length < limit; i--) {
      out.push(recs[i]!);
    }
  }
  return out;
}

/** List `${prefix-}YYYY-MM-DD.jsonl` files in `dir`, sorted newest date first.
 *  Missing/unreadable dir → []. */
function datedFiles(dir: string, prefix: string): string[] {
  const re = prefix
    ? new RegExp(`^${escapeRe(prefix)}-(\\d{4}-\\d{2}-\\d{2})\\.jsonl$`)
    : /^(\d{4}-\d{2}-\d{2})\.jsonl$/;
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  return entries
    .map((name) => {
      const m = re.exec(name);
      return m && m[1] ? { name, date: m[1] } : null;
    })
    .filter((x): x is { name: string; date: string } => x !== null)
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0)) // desc
    .map((x) => x.name);
}

/** Read up to `maxBytes` from the tail of a file and parse the whole (JSON) lines
 *  it contains, in file order. If the window starts mid-file, the first (partial)
 *  line is dropped. Unparseable lines (incl. a half-written trailing line) are
 *  skipped. Missing file → []. */
function readTailFile(path: string, maxBytes: number): Array<Record<string, unknown>> {
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch {
    return [];
  }
  try {
    const size = fstatSync(fd).size;
    if (size === 0) return [];
    const start = Math.max(0, size - maxBytes);
    const len = size - start;
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, start);
    let text = buf.toString("utf8");
    if (start > 0) {
      // We cut into the middle of a line — drop that partial head.
      const nl = text.indexOf("\n");
      text = nl >= 0 ? text.slice(nl + 1) : "";
    }
    const recs: Array<Record<string, unknown>> = [];
    for (const line of text.split("\n")) {
      const t = line.trim();
      if (!t) continue;
      try {
        const rec = JSON.parse(t) as unknown;
        if (rec && typeof rec === "object" && !Array.isArray(rec)) {
          recs.push(rec as Record<string, unknown>);
        }
      } catch {
        // tolerate a malformed line (truncated head / half-written trailing line)
      }
    }
    return recs;
  } finally {
    closeSync(fd);
  }
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
