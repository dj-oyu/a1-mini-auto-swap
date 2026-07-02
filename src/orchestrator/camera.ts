// A1/P1 chamber-camera WIRE FORMAT (proprietary port-6000 protocol, ~1fps).
// 実測 2026-07-02 against a real A1 mini:
//   - TLS (self-signed cert) on port 6000
//   - auth: one 80-byte packet — header 0x40, 0x3000, 0, 0 (u32 LE) +
//     username[32] (NUL-padded "bblp") + access code[32] (NUL-padded)
//   - stream: per frame a 16-byte header (u32 LE payload size at offset 0)
//     followed by exactly that many JPEG bytes (FFD8 … FFD9); first frame
//     arrives ~3s after connect (246KB @1080p observed)
//
// This module is the PURE codec (auth packet + incremental frame parser). The
// connection lifecycle lives in camera-relay.ts (CameraRelay), which holds at
// most one upstream socket and fans frames out to every consumer (MJPEG tabs +
// one-off snapshots) — a persistent shared stream, not per-call connects, so the
// printer's scarce camera slot is never churned and Bambu Studio's liveview is
// disturbed at most once.

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
