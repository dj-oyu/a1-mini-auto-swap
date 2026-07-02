import { readFileSync } from "node:fs";
import { uploadViaCurl } from "./ftps-curl.ts";
import type { UploadProgressSample } from "./upload-progress-throttle.ts";

// Printer FTPS uploads (spec 2/6). The transfer runs through the system curl
// binary (ftps-curl.ts) — the only client proven to complete a STOR against
// real A1 firmware, which requires a TLS data channel finalized with a proper
// close_notify that Bun's TLS cannot emit (実測 2026-07-02). curl uploads are
// serialized against all other printer FTPS activity (single session slot) and
// expose the same onProgress hook, so the SSE indicator and future
// abort/resume attach unchanged.

export interface FtpsUploadOptions {
  host: string;
  port: number;
  accessCode: string;
  username?: string;
  /** Transfer monitor hook (bytesSent/totalBytes), forwarded to the engine. */
  onProgress?: (p: UploadProgressSample) => void;
  /** Overall transfer deadline. */
  timeoutMs?: number;
  /** Abort the in-flight upload. */
  signal?: AbortSignal;
}

/** Upload a local file to the printer's cache. */
export async function uploadFile(
  opts: FtpsUploadOptions,
  localPath: string,
  remoteName: string,
): Promise<void> {
  await uploadBytes(opts, readFileSync(localPath), remoteName);
}

/** Upload in-memory bytes (used when the artifact is generated, not on disk). */
export async function uploadBytes(
  opts: FtpsUploadOptions,
  data: Buffer,
  remoteName: string,
): Promise<void> {
  await uploadViaCurl(data, remoteName, {
    host: opts.host,
    port: opts.port,
    accessCode: opts.accessCode,
    username: opts.username,
    onProgress: opts.onProgress,
    timeoutMs: opts.timeoutMs,
    signal: opts.signal,
  });
}
