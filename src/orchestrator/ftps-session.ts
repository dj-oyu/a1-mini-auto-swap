import { Client } from "basic-ftp";

// Central FTPS session management for the printer connection.
//
// The real A1 mini's FTPS server effectively has ONE session slot, and an
// abruptly destroyed session (no QUIT) keeps that slot occupied for ~1-2 min,
// timing out / refusing the next connection (実測 2026-07-02 — this wedged the
// Stage 5 dry-run right after the Stage 1-3 diagnostics probe).
//
// Therefore every printer FTPS interaction MUST go through withFtpsSession:
//  - sessions are serialized process-wide (a queue), so concurrent callers
//    (diagnostics probe vs. dispatch upload vs. verify dry-run) never race for
//    the printer's single slot;
//  - the session is always terminated politely: QUIT is sent best-effort in
//    the finally path — including when the body throws — before the socket
//    closes, so the printer releases the slot immediately.

export interface FtpsSessionOptions {
  host: string;
  port: number;
  accessCode: string;
  username?: string; // default "bblp"
  /** Control-socket timeout for this session (basic-ftp), default 30s. */
  timeoutMs?: number;
}

/** Process-wide serialization: at most one printer FTPS session at a time. */
let queue: Promise<unknown> = Promise.resolve();

export function withFtpsSession<T>(
  opts: FtpsSessionOptions,
  fn: (client: Client) => Promise<T>,
): Promise<T> {
  const prev = queue;
  const run = (async () => {
    await prev.catch(() => {}); // a predecessor's failure must not block us
    return openAndRun(opts, fn);
  })();
  queue = run.catch(() => {}); // keep the chain alive regardless of outcome
  return run;
}

async function openAndRun<T>(
  opts: FtpsSessionOptions,
  fn: (client: Client) => Promise<T>,
): Promise<T> {
  const client = new Client(opts.timeoutMs ?? 30_000);
  const t0 = Date.now();
  const phase = (msg: string) => console.log(`[ftps] ${msg} (+${Date.now() - t0}ms)`);
  // FTPS_TRACE=1: dump the full control dialogue (field triage — shows exactly
  // which command drew which reply / where the server dropped the connection).
  // basic-ftp's verbose log masks the PASS argument itself; keep it that way.
  if (process.env.FTPS_TRACE === "1") {
    client.ftp.verbose = true;
    client.ftp.log = (msg: string) => console.log(`[ftps-trace +${Date.now() - t0}ms] ${msg.trimEnd()}`);
  }
  try {
    await client.access({
      host: opts.host,
      port: opts.port,
      user: opts.username ?? "bblp",
      password: opts.accessCode,
      secure: "implicit",
      // TLS 1.2 PINNED, both bounds: Bambu's FTPS stack is TLS1.2-only and is
      // known to break mid-handshake against 1.3-capable clients (protocol
      // notes: "TLS1.2のみ — 1.3でBambuStudioが途中で壊れた"). A default
      // Node/Bun ClientHello offers 1.3 (extra extensions/keyshares); pinning
      // 1.2 reproduces Bambu Studio's known-good wire behavior. Cert checks
      // stay off per spec 2 (self-signed printer cert).
      secureOptions: {
        rejectUnauthorized: false,
        minVersion: "TLSv1.2",
        maxVersion: "TLSv1.2",
      },
    });
    // Phase logging (field triage): pinpoints WHERE a failing session dies —
    // before connect, after login, or mid-transfer. Low volume: FTPS ops
    // happen at plate cadence.
    phase("session open: TLS+login ok");
    const result = await fn(client);
    phase("session body done");
    return result;
  } finally {
    // Polite goodbye even when fn threw — as long as the control connection
    // is still alive. Never let the goodbye itself mask the real error.
    if (!client.closed) await client.send("QUIT").catch(() => {});
    client.close();
  }
}

/** Transient connect-phase failures worth retrying: the A1's single-session
 *  FTPS server times out / refuses while it still holds a previous session
 *  (or is briefly refusing right after a printer reboot). */
export function isTransientConnectError(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  return /timeout|timed out|ECONNREFUSED|ECONNRESET|EHOSTUNREACH/i.test(msg);
}

/** A single ECONNREFUSED can be benign (FTPS service still booting after a
 *  printer restart), but REPEATED refusals mean the server has wedged — 実測
 *  2026-07-02: once it settles into refusing, only a printer reboot clears it;
 *  further retries just hammer it. */
export function isRefusedError(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  return /ECONNREFUSED/i.test(msg);
}

/** Raised when the printer's FTPS server is wedged (see isWedgedError). */
export class FtpsWedgedError extends Error {
  constructor(cause: string) {
    super(
      `printer FTPS server is refusing connections (${cause}) — ` +
        `プリンターの再起動が必要です (FTPS wedge, docs/bambu-protocol-notes.md 実機実測ノート)`,
    );
  }
}

export interface FtpsRetryOptions extends FtpsSessionOptions {
  /** Session attempts before giving up (default 4). */
  retries?: number;
  /** Wait between attempts (default 20s — long enough to cross the printer's
   *  ~1-2 min slot-hold window across several attempts). */
  retryDelayMs?: number;
}

/** withFtpsSession + retry on transient connect failures. Hard failures
 *  (e.g. wrong access code → FTP 530) fail fast without retrying. */
export async function withFtpsRetry<T>(
  opts: FtpsRetryOptions,
  fn: (client: Client) => Promise<T>,
): Promise<T> {
  const attempts = Math.max(1, opts.retries ?? 4);
  const delayMs = opts.retryDelayMs ?? 20_000;
  let lastErr: unknown;
  let consecutiveRefused = 0;
  for (let i = 1; i <= attempts; i++) {
    try {
      return await withFtpsSession(opts, fn);
    } catch (e) {
      lastErr = e;
      // Two refusals in a row = the server has wedged (not just booting):
      // fail fast with an actionable message — more attempts only hammer it
      // further and cannot succeed until the printer reboots.
      consecutiveRefused = isRefusedError(e) ? consecutiveRefused + 1 : 0;
      if (consecutiveRefused >= 2) {
        console.warn(`[ftps] server keeps refusing connections — printer reboot required (giving up)`);
        throw new FtpsWedgedError((e as Error).message);
      }
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
