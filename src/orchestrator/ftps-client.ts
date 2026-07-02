import { Readable } from "node:stream";
import { withFtpsRetry, type FtpsRetryOptions } from "./ftps-session.ts";

// Printer FTPS uploads (spec 2/6). All session lifecycle concerns — the
// process-wide serialization, the polite QUIT, and transient-failure retries —
// live in ftps-session.ts; this module only knows WHAT to do inside a session.

export interface FtpsUploadOptions extends FtpsRetryOptions {}

/**
 * Upload a local file to the printer's implicit-FTPS cache. One session per
 * attempt: connect, STOR, QUIT, close (ftps-session.ts). A1 firmware may fall
 * back to PROT C (spec 20.6); basic-ftp handles either over the control session.
 */
export async function uploadFile(
  opts: FtpsUploadOptions,
  localPath: string,
  remoteName: string,
): Promise<void> {
  await withFtpsRetry(opts, (c) => c.uploadFrom(localPath, remoteName));
}

/** Upload in-memory bytes (used when the artifact is generated, not on disk). */
export async function uploadBytes(
  opts: FtpsUploadOptions,
  data: Buffer,
  remoteName: string,
): Promise<void> {
  // A fresh Readable per attempt — a stream can only be consumed once.
  await withFtpsRetry(opts, (c) => c.uploadFrom(Readable.from(data), remoteName));
}
