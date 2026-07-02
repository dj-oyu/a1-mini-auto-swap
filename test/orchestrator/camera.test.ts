// A1/P1 chamber-camera client (orchestrator/camera.ts). Wire format 実測
// 2026-07-02 against a real A1 mini: 80-byte auth packet, then 16-byte frame
// headers (u32 LE size) + JPEG payloads. Integration runs against a fake TLS
// camera server (same certs as the stub).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createServer as tlsCreateServer, type Server, type TLSSocket } from "node:tls";
import { join } from "node:path";
import {
  BambuCameraSource,
  buildCameraAuthPacket,
  CameraFrameParser,
} from "../../src/orchestrator/camera.ts";
import { ensureCerts } from "../../src/stub/tls.ts";
import type { Clock } from "../../src/core/ports.ts";

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

describe("BambuCameraSource (integration vs fake camera server)", () => {
  const CERT_DIR = join(process.cwd(), "certs");
  let server: Server;
  let port: number;
  let connections = 0;
  let mode: "frame" | "silent" = "frame";

  class FakeClock implements Clock {
    t = 1_000_000;
    now(): number {
      return this.t;
    }
  }

  beforeAll(async () => {
    const { key, cert } = ensureCerts(CERT_DIR);
    server = tlsCreateServer({ key, cert }, (sock: TLSSocket) => {
      connections++;
      let got = 0;
      sock.on("data", (c: Buffer) => {
        got += c.length;
        // After the 80-byte auth packet, stream one frame (unless silent).
        if (got >= 80 && mode === "frame") sock.write(frameOf(JPEG));
      });
      sock.on("error", () => {});
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    port = (server.address() as { port: number }).port;
  });
  afterAll(() => server.close());

  const source = (clock: Clock, timeoutMs = 4000) =>
    new BambuCameraSource({ host: "127.0.0.1", port, accessCode: "code", timeoutMs, clock });

  test("captures a frame on demand (auth → header+payload → JPEG)", async () => {
    mode = "frame";
    const s = source(new FakeClock());
    const frame = await s.latest();
    expect(frame).not.toBeNull();
    expect(frame!.contentType).toBe("image/jpeg");
    expect(Buffer.from(frame!.bytes).equals(JPEG)).toBe(true);
  });

  test("TTL cache: a second latest() within the TTL reuses the frame (no reconnect)", async () => {
    mode = "frame";
    const clock = new FakeClock();
    const s = source(clock);
    const before = connections;
    await s.latest();
    expect(connections).toBe(before + 1);
    await s.latest(); // clock unchanged → cached
    expect(connections).toBe(before + 1);
    clock.t += 60_000; // TTL expired
    await s.latest();
    expect(connections).toBe(before + 2);
  });

  test("concurrent callers coalesce onto one capture", async () => {
    mode = "frame";
    const s = source(new FakeClock());
    const before = connections;
    const [a, b] = await Promise.all([s.latest(), s.latest()]);
    expect(connections).toBe(before + 1);
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
  });

  test("a silent camera degrades to null after the timeout — never throws (spec 20.8)", async () => {
    mode = "silent";
    const s = source(new FakeClock(), 700);
    const frame = await s.latest();
    expect(frame).toBeNull();
    mode = "frame";
  });

  test("an unreachable camera degrades to null", async () => {
    const s = new BambuCameraSource({ host: "127.0.0.1", port: 1, accessCode: "x", timeoutMs: 1000 });
    expect(await s.latest()).toBeNull();
  });
});
