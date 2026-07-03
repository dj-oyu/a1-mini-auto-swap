import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runSerialized } from "./ftps-session.ts";
import type { UploadProgressSample } from "./upload-progress-throttle.ts";

// FTPS upload via the system `curl` binary.
//
// Why not in-process: the real A1 requires a TLS data channel AND a proper TLS
// close_notify to finalize a STOR (実測 2026-07-02). Bun's TLS never sends
// close_notify (raw-record sniff confirmed), so every in-process upload hangs
// waiting for the 226; node-forge can't speak the printer's TLS1.2+GCM. curl
// (OpenSSL/schannel) does the clean shutdown and was proven to get 226 against
// this printer. The orchestrator still owns the transfer: progress comes from
// the stdin pipe we feed, abort is a process kill, resume (curl -C -) attaches
// here later. curl is ubiquitous (Windows 10+, every Linux controller host).
//
// Secret hygiene: the access code is passed via a mode-0600 temp config file
// (curl -K), NEVER on argv/env — so it never appears in the process table or
// logs. The config file is unlinked in the finally path.

export interface CurlUploadOptions {
  host: string;
  port: number;
  accessCode: string;
  username?: string; // default "bblp"
  onProgress?: (p: UploadProgressSample) => void;
  /** Floor for `--max-time`, and an explicit override when a caller wants a
   *  larger hard ceiling. Default 120s. The real early-abort is the stall
   *  guard (`--speed-limit`/`--speed-time`), not this — see buildCurlArgs. */
  timeoutMs?: number;
  /** curl `--speed-limit` (bytes/s). Below this for `speedTimeSeconds`
   *  continuous seconds → curl aborts. Default 1024 (1 KB/s). */
  speedLimitBytesPerSec?: number;
  /** curl `--speed-time` (seconds) — the stall window paired with
   *  `speedLimitBytesPerSec`. Default 30s. */
  speedTimeSeconds?: number;
  /** Conservative throughput floor (bytes/s) used to size `--max-time` from the
   *  payload length. Default 40_000 (40 KB/s). Overridable so tests can exercise
   *  the size-aware ceiling with a small stand-in buffer. */
  floorBytesPerSec?: number;
  /** Abort the in-flight upload (kills curl). */
  signal?: AbortSignal;
  /** Override the curl binary (tests / non-PATH installs). Default "curl". */
  curlPath?: string;
}

/** Default stall guard: abort only if throughput stays under 1 KB/s for 30
 *  continuous seconds. A healthy ~130 KB/s A1 transfer never trips this; a dead
 *  connection aborts in ~30s. */
export const DEFAULT_SPEED_LIMIT_BYTES_PER_SEC = 1024;
export const DEFAULT_SPEED_TIME_SECONDS = 30;
/** Conservative throughput floor for sizing the hard `--max-time` ceiling. */
export const DEFAULT_FLOOR_BYTES_PER_SEC = 40_000;
/** Slack added on top of the size-derived ceiling for TLS/PASV handshake. */
export const HANDSHAKE_MARGIN_MS = 30_000;
export const DEFAULT_TIMEOUT_MS = 120_000;

/**
 * Build the curl argv for an upload. Pure (no I/O) so it is unit-testable
 * without a network or wall-clock. The credential file (`-K`) is referenced by
 * path only — the access code never appears here.
 *
 * Timeout strategy — fixes the real-hardware bug where a 22 MB `.gcode.3mf` at
 * the A1's measured ~130 KB/s needs ~170s but a flat `--max-time 120` killed the
 * transfer at ~67% (~16 MB), so the gcode never fully reached the printer and
 * the print never started:
 *  - `--speed-limit`/`--speed-time` are the real early-abort: they fire only on
 *    a genuine stall (throughput under the limit for the whole window), so a
 *    slow-but-progressing upload of ANY size completes.
 *  - `--max-time` is a SIZE-AWARE backstop, not a flat deadline: derived from
 *    the payload length assuming a pessimistic throughput floor, so a 22 MB file
 *    gets a ~580s ceiling (22e6/40e3 = 550s + 30s margin) while a tiny file
 *    keeps the 120s floor. `opts.timeoutMs` is an explicit floor/override,
 *    never a cap.
 */
export function buildCurlArgs(
  cfgPath: string,
  url: string,
  dataLength: number,
  opts: CurlUploadOptions,
): string[] {
  const speedLimit = opts.speedLimitBytesPerSec ?? DEFAULT_SPEED_LIMIT_BYTES_PER_SEC;
  const speedTime = opts.speedTimeSeconds ?? DEFAULT_SPEED_TIME_SECONDS;
  const floor = opts.floorBytesPerSec ?? DEFAULT_FLOOR_BYTES_PER_SEC;
  const sizeMs = (dataLength / floor) * 1000;
  const effectiveMaxMs = Math.max(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS, sizeMs + HANDSHAKE_MARGIN_MS);
  return [
    "-K", cfgPath, // credentials (off argv)
    "-k", // self-signed printer cert (spec 2)
    "--ssl-reqd", // require TLS on the control channel (implicit FTPS)
    "--disable-epsv", // A1 rejects EPSV (502, 実測) — force PASV
    "-T", "-", // upload payload from stdin (we stream → progress)
    "-sS", // quiet but show errors
    "--speed-limit", String(speedLimit), // stall guard: bytes/s floor…
    "--speed-time", String(speedTime), // …sustained this many seconds → abort
    "--max-time", String(Math.ceil(effectiveMaxMs / 1000)), // size-aware hard ceiling
    url,
  ];
}

export class CurlNotFoundError extends Error {
  constructor(bin: string) {
    super(`'${bin}' not found — install curl (Windows 10+ bundles it; every Linux controller host has it)`);
  }
}

/**
 * Upload `data` to `remotePath` (e.g. "/cache/job-12.gcode.3mf") on the printer
 * over implicit FTPS. Serialized against all other printer FTPS activity (the
 * single-slot rule). Resolves when curl exits 0 (226 received); rejects with
 * curl's stderr otherwise.
 */
export function uploadViaCurl(
  data: Buffer,
  remotePath: string,
  opts: CurlUploadOptions,
): Promise<void> {
  return runSerialized(() => runCurl(data, remotePath, opts));
}

function runCurl(data: Buffer, remotePath: string, opts: CurlUploadOptions): Promise<void> {
  const curlBin = opts.curlPath ?? "curl";
  const user = opts.username ?? "bblp";
  const url = `ftps://${opts.host}:${opts.port}${remotePath.startsWith("/") ? "" : "/"}${remotePath}`;

  // Credentials via a 0600 config file (curl -K), never on argv/env.
  const dir = mkdtempSync(join(tmpdir(), "ftps-curl-"));
  const cfgPath = join(dir, "curl.cfg");
  writeFileSync(cfgPath, `user = "${user}:${opts.accessCode}"\n`, { mode: 0o600 });

  return new Promise<void>((resolve, reject) => {
    const args = buildCurlArgs(cfgPath, url, data.length, opts);

    let child;
    try {
      child = spawn(curlBin, args, { stdio: ["pipe", "ignore", "pipe"] });
    } catch (e) {
      cleanup();
      reject(wrapSpawnError(e, curlBin));
      return;
    }

    let stderr = "";
    let settled = false;
    const done = (fn: () => void) => {
      if (settled) return;
      settled = true;
      cleanup();
      fn();
    };

    const onAbort = () => {
      child.kill("SIGKILL");
      done(() => reject(new Error("upload aborted")));
    };
    if (opts.signal) {
      if (opts.signal.aborted) {
        child.kill("SIGKILL");
        cleanup();
        reject(new Error("upload aborted"));
        return;
      }
      opts.signal.addEventListener("abort", onAbort, { once: true });
    }

    child.stderr?.on("data", (c: Buffer) => (stderr += c.toString()));
    child.on("error", (e) => done(() => reject(wrapSpawnError(e, curlBin))));
    child.on("close", (code) => {
      opts.signal?.removeEventListener("abort", onAbort);
      if (code === 0) done(() => resolve());
      else done(() => reject(new Error(`curl exited ${code}: ${stderr.trim() || "upload failed"}`)));
    });

    // Stream the payload to curl's stdin in chunks, reporting progress. Node's
    // pipe backpressure keeps this roughly in step with the network, so the
    // byte count is a faithful transfer indicator.
    const stdin = child.stdin!;
    stdin.on("error", () => {}); // EPIPE if curl died — surfaced via 'close'
    let off = 0;
    const CHUNK = 64 * 1024;
    const pump = (): void => {
      while (off < data.length) {
        const end = Math.min(off + CHUNK, data.length);
        const chunk = data.subarray(off, end);
        off = end;
        const ok = stdin.write(chunk);
        opts.onProgress?.({ bytesSent: off, totalBytes: data.length });
        if (!ok) {
          stdin.once("drain", pump);
          return;
        }
      }
      stdin.end();
    };
    pump();
  });

  function cleanup(): void {
    rmSync(dir, { recursive: true, force: true });
  }
}

function wrapSpawnError(e: unknown, bin: string): Error {
  const code = (e as { code?: string }).code;
  if (code === "ENOENT") return new CurlNotFoundError(bin);
  return e instanceof Error ? e : new Error(String(e));
}
