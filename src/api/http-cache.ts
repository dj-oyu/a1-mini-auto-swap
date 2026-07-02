import { statSync } from "node:fs";

// HTTP caching for the id-keyed, MUTABLE upload-cache artifacts (thumbnail /
// model / plate-mesh). These live at cacheFileName(jobId), so the URL is stable
// but the BYTES behind it are not: a job id can be REUSED (harness restart
// resets the in-memory DB → same id; SQLite rowid reuse after delete) and the
// upload route overwrites the file. `cache-control: public, max-age=…` there let
// a browser serve a PRIOR job's mesh for the identical URL (a-d shown for
// Letters). The fix: revalidate every time (`no-cache`) against a validator that
// changes when the file bytes change, so the server 304s only when truly
// unchanged and always ships fresh bytes otherwise.

/**
 * A cache validator (ETag) derived from the cache file's size + mtime, plus any
 * `extra` discriminators (e.g. the plate id, which selects a different slice of
 * the same file). Overwriting the file — a new upload reusing a job id — bumps
 * the mtime (and usually the size), so a stale `If-None-Match` can never match.
 * Returns null when the file can't be stat'd (caller then skips revalidation).
 */
export function artifactETag(path: string, ...extra: (string | number)[]): string | null {
  try {
    const st = statSync(path);
    return `W/"${[st.size, Math.round(st.mtimeMs), ...extra].join("-")}"`;
  } catch {
    return null;
  }
}
