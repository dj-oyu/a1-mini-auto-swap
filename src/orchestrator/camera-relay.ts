import { connect as tlsConnect, type TLSSocket } from "node:tls";
import type { Clock } from "../core/ports.ts";
import { systemClock } from "../core/ports.ts";
import type { SnapshotSource } from "../api/snapshot-routes.ts";
import { buildCameraAuthPacket, CameraFrameParser } from "./camera.ts";
import { moduleLogger } from "../obs/default-logger.ts";

// Camera RELAY (spec ch8 / spec 17 §5). The A1/P1 chamber camera (port-6000 TLS
// protocol, wire format 実測 2026-07-02 — see camera.ts) exposes a scarce number
// of connection slots and fights Bambu Studio's liveview when held open. So the
// server keeps AT MOST ONE upstream connection and fans every JPEG frame out to
// all consumers (any number of browser tabs on the MJPEG stream, plus one-off
// snapshot callers). The upstream opens on the first subscriber and, after the
// LAST unsubscribe, lingers briefly before disconnecting so a modal reopen (or a
// snapshot right after a stream) reuses the live slot instead of churning it.
//
// Everything degrades gracefully (spec 20.8): a dead/hung camera never throws
// into a caller — snapshot() resolves null, the MJPEG stream simply stalls, and
// errors are logged, never surfaced. No secrets are logged (access code stays
// out of every message).

/** The relay surface consumed by the HTTP routes. `CameraRelay` is the real
 *  implementation; the dev harness supplies a fake one. */
export interface FrameRelay {
  /** Register a frame listener. Opens the upstream on the first subscriber.
   *  Returns an unsubscribe fn; the last unsubscribe schedules the linger. */
  subscribe(onFrame: (jpeg: Buffer) => void): () => void;
  /** Latest buffered frame, or null if none is available yet / upstream down. */
  latest(): Buffer | null;
  /** Latest frame if present; otherwise a one-shot capture (temporary subscribe
   *  until the first frame). Resolves null on timeout/failure — never rejects. */
  snapshot(timeoutMs?: number): Promise<Buffer | null>;
}

export interface CameraRelayOptions {
  host: string;
  accessCode: string;
  port?: number; // default 6000
  username?: string; // default "bblp"
  /** Keep the upstream alive this long after the last unsubscribe (default 15s).
   *  Injectable so tests can drive short lingers without wall-clock waits. */
  lingerMs?: number;
  /** Reconnect backoff bounds while subscribers are present (default 1s → 15s). */
  backoffBaseMs?: number;
  backoffMaxMs?: number;
  /** Default budget for snapshot()'s one-shot capture (default 10s — first frame
   *  took ~3s in the field). */
  snapshotTimeoutMs?: number;
  clock?: Clock;
}

type Listener = (jpeg: Buffer) => void;

export class CameraRelay implements FrameRelay {
  private readonly listeners = new Set<Listener>();
  private sock: TLSSocket | null = null;
  private connecting = false;
  private latestFrame: Buffer | null = null;
  private lingerTimer: ReturnType<typeof setTimeout> | null = null;
  private backoffTimer: ReturnType<typeof setTimeout> | null = null;
  private backoffMs: number;
  private readonly clock: Clock;
  /** Total upstream connect attempts — test observability (single-connection). */
  private connects = 0;

  constructor(private readonly opts: CameraRelayOptions) {
    this.clock = opts.clock ?? systemClock;
    this.backoffMs = opts.backoffBaseMs ?? 1_000;
  }

  subscribe(onFrame: Listener): () => void {
    this.listeners.add(onFrame);
    // A consumer is back: cancel any pending linger shutdown and make sure the
    // upstream is (coming) up.
    if (this.lingerTimer) {
      clearTimeout(this.lingerTimer);
      this.lingerTimer = null;
    }
    this.ensureUpstream();
    // Replay the last frame to the newcomer so a second tab (or a reopen) shows
    // an image immediately instead of waiting a full ~1s frame interval. Async
    // so the caller finishes wiring (e.g. snapshot()'s unsub) before delivery.
    const buffered = this.latestFrame;
    if (buffered) {
      queueMicrotask(() => {
        if (this.listeners.has(onFrame)) this.deliver(onFrame, buffered);
      });
    }
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      this.listeners.delete(onFrame);
      if (this.listeners.size === 0) this.scheduleLinger();
    };
  }

  latest(): Buffer | null {
    return this.latestFrame;
  }

  async snapshot(timeoutMs = this.opts.snapshotTimeoutMs ?? 10_000): Promise<Buffer | null> {
    const buffered = this.latestFrame;
    if (buffered) return buffered;
    // No frame yet — temporarily subscribe until the first one arrives. The
    // linger keeps this from churning the upstream when snapshots come in bursts.
    return new Promise<Buffer | null>((resolve) => {
      let done = false;
      let unsub: (() => void) | null = null;
      let timer: ReturnType<typeof setTimeout>;
      const finish = (v: Buffer | null) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        unsub?.();
        resolve(v);
      };
      timer = setTimeout(() => finish(null), timeoutMs);
      try {
        unsub = this.subscribe((jpeg) => finish(jpeg));
      } catch (e) {
        this.warn(`snapshot subscribe failed: ${errMsg(e)}`);
        finish(null);
      }
    });
  }

  /** Upstream connect attempts so far (tests assert at most one is live). */
  connectCount(): number {
    return this.connects;
  }

  /** Whether an upstream socket currently exists (tests assert linger teardown). */
  isUpstreamUp(): boolean {
    return this.sock !== null;
  }

  // ── internals ──────────────────────────────────────────────────────────────

  private ensureUpstream(): void {
    // Already connected, mid-connect, or a reconnect is scheduled → nothing to do.
    if (this.sock || this.connecting || this.backoffTimer) return;
    this.openUpstream();
  }

  private openUpstream(): void {
    this.connecting = true;
    this.connects++;
    const host = this.opts.host;
    const port = this.opts.port ?? 6000;
    const username = this.opts.username ?? "bblp";
    const parser = new CameraFrameParser();
    let sock: TLSSocket;
    try {
      sock = tlsConnect({ host, port, rejectUnauthorized: false }, () => {
        sock.write(buildCameraAuthPacket(username, this.opts.accessCode));
      });
    } catch (e) {
      // Synchronous connect failure (e.g. bad host) — treat as a closed upstream.
      this.connecting = false;
      this.warn(`connect failed: ${errMsg(e)}`);
      this.onUpstreamGone();
      return;
    }
    this.sock = sock;
    sock.on("data", (chunk: Buffer) => {
      // push() yields the FIRST complete frame; drain the rest with empty pushes.
      let frame = parser.push(chunk);
      while (frame) {
        this.onFrame(frame);
        frame = parser.push(Buffer.alloc(0));
      }
    });
    sock.on("error", (e: Error) => this.warn(`upstream error: ${e.message}`));
    sock.on("close", () => {
      if (this.sock === sock) this.onUpstreamGone();
    });
  }

  private onFrame(jpeg: Buffer): void {
    this.connecting = false;
    this.backoffMs = this.opts.backoffBaseMs ?? 1_000; // healthy stream → reset
    this.latestFrame = jpeg;
    void this.clock.now(); // timestamp hook (Clock port); frame is "now"
    for (const l of [...this.listeners]) this.deliver(l, jpeg);
  }

  private deliver(l: Listener, jpeg: Buffer): void {
    try {
      l(jpeg);
    } catch (e) {
      this.warn(`listener threw: ${errMsg(e)}`);
    }
  }

  private onUpstreamGone(): void {
    this.sock = null;
    this.connecting = false;
    // Reconnect only while someone is watching; an idle relay stays down.
    if (this.listeners.size > 0) this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.backoffTimer || this.sock || this.connecting) return;
    const delay = this.backoffMs;
    this.backoffMs = Math.min(this.backoffMs * 2, this.opts.backoffMaxMs ?? 15_000);
    this.backoffTimer = setTimeout(() => {
      this.backoffTimer = null;
      if (this.listeners.size > 0) this.openUpstream();
    }, delay);
    this.backoffTimer.unref?.();
  }

  private scheduleLinger(): void {
    const lingerMs = this.opts.lingerMs ?? 15_000;
    if (this.lingerTimer) clearTimeout(this.lingerTimer);
    this.lingerTimer = setTimeout(() => {
      this.lingerTimer = null;
      if (this.listeners.size === 0) this.teardown();
    }, lingerMs);
    this.lingerTimer.unref?.();
  }

  private teardown(): void {
    if (this.backoffTimer) {
      clearTimeout(this.backoffTimer);
      this.backoffTimer = null;
    }
    this.backoffMs = this.opts.backoffBaseMs ?? 1_000;
    this.latestFrame = null; // stale once the upstream is gone
    const sock = this.sock;
    this.sock = null;
    this.connecting = false;
    if (sock) sock.destroy();
  }

  private warn(msg: string): void {
    moduleLogger("camera").warn(msg, { event: "camera_relay_warn" });
  }
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Adapt a relay to the SnapshotSource port (GET /api/printer/snapshot). The
 *  snapshot endpoint serves whatever the relay is already streaming, so the
 *  camera modal (MJPEG) and one-off snapshots (webhook attachment, verify) share
 *  the single upstream. */
export function relaySnapshotSource(relay: FrameRelay, timeoutMs?: number): SnapshotSource {
  return {
    async latest() {
      const jpeg = await relay.snapshot(timeoutMs);
      return jpeg ? { contentType: "image/jpeg", bytes: jpeg } : null;
    },
  };
}
