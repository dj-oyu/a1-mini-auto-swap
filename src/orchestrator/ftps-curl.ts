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
  /** Overall transfer deadline, default 120s (large plates + retries). */
  timeoutMs?: number;
  /** Abort the in-flight upload (kills curl). */
  signal?: AbortSignal;
  /** Override the curl binary (tests / non-PATH installs). Default "curl". */
  curlPath?: string;
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
  const timeoutMs = opts.timeoutMs ?? 120_000;
  const url = `ftps://${opts.host}:${opts.port}${remotePath.startsWith("/") ? "" : "/"}${remotePath}`;

  // Credentials via a 0600 config file (curl -K), never on argv/env.
  const dir = mkdtempSync(join(tmpdir(), "ftps-curl-"));
  const cfgPath = join(dir, "curl.cfg");
  writeFileSync(cfgPath, `user = "${user}:${opts.accessCode}"\n`, { mode: 0o600 });

  return new Promise<void>((resolve, reject) => {
    const args = [
      "-K", cfgPath, // credentials (off argv)
      "-k", // self-signed printer cert (spec 2)
      "--ssl-reqd", // require TLS on the control channel (implicit FTPS)
      "--disable-epsv", // A1 rejects EPSV (502, 実測) — force PASV
      "-T", "-", // upload payload from stdin (we stream → progress)
      "-sS", // quiet but show errors
      "--max-time", String(Math.ceil(timeoutMs / 1000)),
      url,
    ];

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
