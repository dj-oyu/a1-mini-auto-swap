// A1/P1 chamber-camera PURE codec (orchestrator/camera.ts). Wire format 実測
// 2026-07-02 against a real A1 mini: 80-byte auth packet, then 16-byte frame
// headers (u32 LE size) + JPEG payloads. The connection lifecycle (single shared
// upstream, fan-out, linger, reconnect) lives in camera-relay.ts and is covered
// by camera-relay.test.ts against a fake TLS camera server.
import { describe, expect, test } from "bun:test";
import { buildCameraAuthPacket, CameraFrameParser } from "../../src/orchestrator/camera.ts";

const JPEG = Buffer.concat([
  Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
  Buffer.alloc(500, 0x77),
  Buffer.from([0xff, 0xd9]),
]);

function frameOf(payload: Buffer): Buffer {
  const header = Buffer.alloc(16);
  header.writeUInt32LE(payload.length, 0);
  header.writeUInt32LE(1, 8); // observed flag position (実機ヘッダ …0100 0000…)
  return Buffer.concat([header, payload]);
}

describe("buildCameraAuthPacket", () => {
  test("80 bytes: LE header 0x40/0x3000, user at 16, code at 48, NUL padding", () => {
    const p = buildCameraAuthPacket("bblp", "12345678");
    expect(p.length).toBe(80);
    expect(p.readUInt32LE(0)).toBe(0x40);
    expect(p.readUInt32LE(4)).toBe(0x3000);
    expect(p.readUInt32LE(8)).toBe(0);
    expect(p.readUInt32LE(12)).toBe(0);
    expect(p.subarray(16, 20).toString("ascii")).toBe("bblp");
    expect(p[20]).toBe(0); // padded
    expect(p.subarray(48, 56).toString("ascii")).toBe("12345678");
    expect(p[56]).toBe(0);
  });
});

describe("CameraFrameParser", () => {
  test("one whole frame in one chunk", () => {
    const parser = new CameraFrameParser();
    expect(parser.push(frameOf(JPEG))?.equals(JPEG)).toBe(true);
  });

  test("frame split at every chunk boundary still parses", () => {
    const wire = frameOf(JPEG);
    for (const cut of [1, 8, 15, 16, 17, 100, wire.length - 1]) {
      const parser = new CameraFrameParser();
      expect(parser.push(wire.subarray(0, cut))).toBeNull();
      expect(parser.push(wire.subarray(cut))?.equals(JPEG)).toBe(true);
    }
  });

  test("two concatenated frames yield the first, then the second on next push", () => {
    const parser = new CameraFrameParser();
    const wire = Buffer.concat([frameOf(JPEG), frameOf(JPEG)]);
    expect(parser.push(wire)?.equals(JPEG)).toBe(true);
    expect(parser.push(Buffer.alloc(0))?.equals(JPEG)).toBe(true);
  });

  test("non-JPEG control payloads are skipped until a JPEG arrives", () => {
    const parser = new CameraFrameParser();
    const control = Buffer.alloc(32, 0x00);
    expect(parser.push(Buffer.concat([frameOf(control), frameOf(JPEG)]))?.equals(JPEG)).toBe(true);
  });
});
