import { readFileSync } from "node:fs";
import { withFtpsRetry, type FtpsRetryOptions } from "./ftps-session.ts";
import { uploadPlainData, type UploadProgress } from "./ftps-transfer.ts";

// Printer FTPS uploads (spec 2/6). Session lifecycle (serialization, QUIT,
// transient retry) lives in ftps-session.ts; the actual transfer runs over an
// in-process PROT C plaintext data channel (ftps-transfer.ts) because Bun's
// TLSSocket cannot send close_notify and real A1 firmware silently discards a
// PROT P upload closed without one (実測 2026-07-02). Single-process by
// design: the transfer engine exposes onProgress now, pause/abort/resume
// attach at the same layer later.

export interface FtpsUploadOptions extends FtpsRetryOptions {
  /** Transfer monitor hook, forwarded to the data engine. */
  onProgress?: (p: UploadProgress) => void;
}

/**
 * Upload a local file to the printer's cache. One session per attempt:
 * connect (TLS control) → PROT C → PASV → plain STOR → QUIT.
 */
export async function uploadFile(
  opts: FtpsUploadOptions,
  localPath: string,
  remoteName: string,
): Promise<void> {
  const data = readFileSync(localPath);
  await uploadBytes(opts, data, remoteName);
}

/** Upload in-memory bytes (used when the artifact is generated, not on disk). */
export async function uploadBytes(
  opts: FtpsUploadOptions,
  data: Buffer,
  remoteName: string,
): Promise<void> {
  await withFtpsRetry(opts, (c) => uploadPlainData(c, data, remoteName, { onProgress: opts.onProgress }));
}
