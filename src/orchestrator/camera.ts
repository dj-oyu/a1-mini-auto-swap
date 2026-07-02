import { connect as tlsConnect } from "node:tls";
import type { SnapshotFrame, SnapshotSource } from "../api/snapshot-routes.ts";
import type { Clock } from "../core/ports.ts";
import { systemClock } from "../core/ports.ts";

// A1/P1 chamber-camera client (proprietary port-6000 protocol, ~1fps).
// 実測 2026-07-02 against a real A1 mini:
//   - TLS (self-signed cert) on port 6000
//   - auth: one 80-byte packet — header 0x40, 0x3000, 0, 0 (u32 LE) +
//     username[32] (NUL-padded "bblp") + access code[32] (NUL-padded)
//   - stream: per frame a 16-byte header (u32 LE payload size at offset 0)
//     followed by exactly that many JPEG bytes (FFD8 … FFD9); first frame
//     arrives ~3s after connect (246KB @1080p observed)
//
// Capture strategy: ON-DEMAND — connect, take the first complete frame,
// disconnect. A persistent stream would hold the printer's camera slot and
// fight Bambu Studio's liveview; the snapshot use case (camera modal,
// notification attachment) only needs a frame now and then. A short TTL cache
// coalesces bursts (modal open + 更新 clicks), and concurrent callers share
// one in-flight capture. Every path is timeout-guarded (spec 20.8: a hung
// side-effect must never block its caller).

export interface CameraOptions {
  host: string;
  accessCode: string;
  port?: number; // default 6000
  username?: string; // default "bblp"
  /** Give up if no complete frame arrived within this budget (default 10s —
   *  first frame took ~3s in the field). */
  timeoutMs?: number;
  /** Serve a cached frame if it is younger than this (default 3s ≈ the
   *  camera's own frame interval). */
  cacheTtlMs?: number;
  clock?: Clock;
}

/** Build the 80-byte auth packet (pure — unit-tested). */
export function buildCameraAuthPacket(username: string, accessCode: string): Buffer {
  const buf = Buffer.alloc(80);
  buf.writeUInt32LE(0x40, 0);
  buf.writeUInt32LE(0x3000, 4);
  // offsets 8..16 stay zero
  buf.write(username, 16, 32, "ascii");
  buf.write(accessCode, 48, 32, "ascii");
  return buf;
}

/** Incremental frame parser (pure state machine — unit-tested against
 *  arbitrary chunk boundaries). push() returns the first complete JPEG. */
export class CameraFrameParser {
  private acc: Buffer = Buffer.alloc(0);
  private expecting = -1;

  push(chunk: Buffer): Buffer | null {
    this.acc = this.acc.length === 0 ? chunk : Buffer.concat([this.acc, chunk]);
    for (;;) {
      if (this.expecting < 0) {
        if (this.acc.length < 16) return null;
        this.expecting = this.acc.readUInt32LE(0);
        this.acc = this.acc.subarray(16);
      }
      if (this.acc.length < this.expecting) return null;
      const frame = this.acc.subarray(0, this.expecting);
      this.acc = this.acc.subarray(this.expecting);
      this.expecting = -1;
      // Defensive: skip anything that isn't a JPEG (unknown control payloads).
      if (frame.length >= 4 && frame[0] === 0xff && frame[1] === 0xd8) {
        return Buffer.from(frame); // copy — acc gets reused
      }
    }
  }
}

/** On-demand snapshot source over the chamber camera. */
export class BambuCameraSource implements SnapshotSource {
  private cached: { frame: SnapshotFrame; at: number } | null = null;
  private inflight: Promise<SnapshotFrame | null> | null = null;
  private readonly clock: Clock;

  constructor(private readonly opts: CameraOptions) {
    this.clock = opts.clock ?? systemClock;
  }

  latest(): Promise<SnapshotFrame | null> {
    const ttl = this.opts.cacheTtlMs ?? 3_000;
    if (this.cached && this.clock.now() - this.cached.at < ttl) {
      return Promise.resolve(this.cached.frame);
    }
    // Coalesce concurrent callers onto one capture.
    if (!this.inflight) {
      this.inflight = this.captureOnce()
        .then((frame) => {
          if (frame) this.cached = { frame, at: this.clock.now() };
          return frame;
        })
        .catch((e) => {
          console.warn(`[camera] capture failed: ${(e as Error).message}`);
          return null; // a broken camera must not break the caller (spec 20.8)
        })
        .finally(() => {
          this.inflight = null;
        });
    }
    return this.inflight;
  }

  private captureOnce(): Promise<SnapshotFrame | null> {
    const { host, accessCode } = this.opts;
    const port = this.opts.port ?? 6000;
    const timeoutMs = this.opts.timeoutMs ?? 10_000;

    return new Promise((resolve, reject) => {
      const parser = new CameraFrameParser();
      const sock = tlsConnect({ host, port, rejectUnauthorized: false }, () => {
        sock.write(buildCameraAuthPacket(this.opts.username ?? "bblp", accessCode));
      });
      let settled = false;
      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(killer);
        sock.destroy();
        fn();
      };
      const killer = setTimeout(
        () => finish(() => reject(new Error(`no frame within ${timeoutMs}ms`))),
        timeoutMs,
      );
      sock.on("data", (chunk: Buffer) => {
        const jpeg = parser.push(chunk);
        if (jpeg) finish(() => resolve({ contentType: "image/jpeg", bytes: jpeg }));
      });
      sock.on("error", (e: Error) => finish(() => reject(e)));
      sock.on("close", () => finish(() => reject(new Error("camera connection closed before a frame arrived"))));
    });
  }
}
