import { Client } from "basic-ftp";
import { Readable } from "node:stream";

export interface FtpsUploadOptions {
  host: string;
  port: number;
  accessCode: string;
  username?: string; // default "bblp"
  /** Connect attempts before giving up (default 4). Real A1 firmware holds a
   *  closed FTPS session's slot for ~1-2 min, so a fresh connect right after a
   *  previous session can time out / be refused transiently (実測 2026-07-02). */
  retries?: number;
  /** Wait between attempts (default 20s — long enough to cross the hold window). */
  retryDelayMs?: number;
}

/** Transient connect-phase failures worth retrying: the A1's single-session
 *  FTPS server times out or refuses while it still holds the previous session. */
function isTransientConnectError(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  return /timeout|timed out|ECONNREFUSED|ECONNRESET|EHOSTUNREACH/i.test(msg);
}

/** Open a session, run `fn`, then QUIT before closing. Sending QUIT matters on
 *  the real A1: an abruptly destroyed socket leaves the printer-side session
 *  alive until its own timeout, blocking the next connection (the slot-hold
 *  behavior above). basic-ftp's close() alone does NOT send QUIT. */
async function withSession<T>(opts: FtpsUploadOptions, fn: (c: Client) => Promise<T>): Promise<T> {
  const client = new Client();
  try {
    await client.access({
      host: opts.host,
      port: opts.port,
      user: opts.username ?? "bblp",
      password: opts.accessCode,
      secure: "implicit",
      secureOptions: { rejectUnauthorized: false },
    });
    const result = await fn(client);
    await client.send("QUIT").catch(() => {}); // best-effort polite goodbye
    return result;
  } finally {
    client.close();
  }
}

async function withRetry<T>(opts: FtpsUploadOptions, fn: (c: Client) => Promise<T>): Promise<T> {
  const attempts = Math.max(1, opts.retries ?? 4);
  const delayMs = opts.retryDelayMs ?? 20_000;
  let lastErr: unknown;
  for (let i = 1; i <= attempts; i++) {
    try {
      return await withSession(opts, fn);
    } catch (e) {
      lastErr = e;
      if (i === attempts || !isTransientConnectError(e)) throw e;
      console.warn(
        `[ftps] attempt ${i}/${attempts} failed (${(e as Error).message}); ` +
          `retrying in ${Math.round(delayMs / 1000)}s (printer may still hold the previous session)`,
      );
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  throw lastErr; // unreachable, but keeps TS satisfied
}

/**
 * Upload a local file to the printer's implicit-FTPS cache (spec 2/6). One-shot
 * per attempt: connect, STOR, QUIT, close — with transient-failure retries
 * (see FtpsUploadOptions.retries). A1 firmware may fall back to PROT C
 * (spec 20.6); basic-ftp handles either over the control session.
 */
export async function uploadFile(
  opts: FtpsUploadOptions,
  localPath: string,
  remoteName: string,
): Promise<void> {
  await withRetry(opts, (c) => c.uploadFrom(localPath, remoteName));
}

/** Upload in-memory bytes (used when the artifact is generated, not on disk). */
export async function uploadBytes(
  opts: FtpsUploadOptions,
  data: Buffer,
  remoteName: string,
): Promise<void> {
  // A fresh Readable per attempt — a stream can only be consumed once.
  await withRetry(opts, (c) => c.uploadFrom(Readable.from(data), remoteName));
}
