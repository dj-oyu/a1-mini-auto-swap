// CameraRelay (orchestrator/camera-relay.ts) — the single-upstream, fan-out
// relay for the port-6000 chamber camera. Runs against a controllable fake TLS
// camera server (same self-signed certs as the stub), so every path is exercised
// without a real printer. Lingers/backoffs are injected short and every wait is
// event-driven (a server-side connect/close), so there are no wall-clock sleeps.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createServer as tlsCreateServer, type Server, type TLSSocket } from "node:tls";
import { join } from "node:path";
import { CameraRelay, relaySnapshotSource } from "../../src/orchestrator/camera-relay.ts";
import { ensureCerts, type TlsMaterial } from "../../src/stub/tls.ts";

const JPEG = Buffer.concat([
  Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
  Buffer.alloc(300, 0x55),
  Buffer.from([0xff, 0xd9]),
]);

function frameOf(payload: Buffer): Buffer {
  const header = Buffer.alloc(16);
  header.writeUInt32LE(payload.length, 0);
  header.writeUInt32LE(1, 8);
  return Buffer.concat([header, payload]);
}

/** A fake port-6000 camera. Each connection authenticates (80-byte packet) then
 *  the test drives frames (broadcast) or drops the socket (killAll). Connect and
 *  close events are exposed as promises so tests await state changes instead of
 *  sleeping. */
class FakeCamera {
  server!: Server;
  port = 0;
  connections = 0;
  private readonly live = new Set<TLSSocket>();
  private readonly authed: TLSSocket[] = [];
  private readonly connWaiters: Array<(s: TLSSocket) => void> = [];
  private readonly closes: TLSSocket[] = [];
  private readonly closeWaiters: Array<(s: TLSSocket) => void> = [];
  autoFrame = false;

  async start({ key, cert }: TlsMaterial): Promise<void> {
    this.server = tlsCreateServer({ key, cert }, (sock: TLSSocket) => {
      this.connections++;
      this.live.add(sock);
      let got = 0;
      let authed = false;
      sock.on("data", (c: Buffer) => {
        got += c.length;
        if (!authed && got >= 80) {
          authed = true;
          if (this.autoFrame) sock.write(frameOf(JPEG));
          const w = this.connWaiters.shift();
          if (w) w(sock);
          else this.authed.push(sock);
        }
      });
      sock.on("error", () => {});
      sock.on("close", () => {
        this.live.delete(sock);
        const w = this.closeWaiters.shift();
        if (w) w(sock);
        else this.closes.push(sock);
      });
    });
    await new Promise<void>((r) => this.server.listen(0, "127.0.0.1", r));
    this.port = (this.server.address() as { port: number }).port;
  }

  /** Resolves on the next upstream connection that has authenticated. */
  nextConnection(): Promise<TLSSocket> {
    const ready = this.authed.shift();
    if (ready) return Promise.resolve(ready);
    return new Promise((r) => this.connWaiters.push(r));
  }

  /** Resolves the next time an upstream socket closes. */
  nextClose(): Promise<TLSSocket> {
    const done = this.closes.shift();
    if (done) return Promise.resolve(done);
    return new Promise((r) => this.closeWaiters.push(r));
  }

  broadcast(frame: Buffer = frameOf(JPEG)): void {
    for (const s of [...this.live]) s.write(frame);
  }

  killAll(): void {
    for (const s of [...this.live]) s.destroy();
  }

  liveCount(): number {
    return this.live.size;
  }

  stop(): void {
    this.killAll();
    this.server.close();
  }
}

/** A frame listener that lets tests await the Nth delivered frame. */
function collector() {
  const frames: Buffer[] = [];
  const waiters: Array<{ n: number; resolve: () => void }> = [];
  const onFrame = (jpeg: Buffer): void => {
    frames.push(jpeg);
    for (let i = waiters.length - 1; i >= 0; i--) {
      if (frames.length >= waiters[i]!.n) {
        waiters[i]!.resolve();
        waiters.splice(i, 1);
      }
    }
  };
  const waitFor = (n: number): Promise<void> =>
    new Promise((resolve) => {
      if (frames.length >= n) resolve();
      else waiters.push({ n, resolve });
    });
  return { frames, onFrame, waitFor };
}

describe("CameraRelay (integration vs fake camera)", () => {
  const CERT_DIR = join(process.cwd(), "certs");
  const certs = ensureCerts(CERT_DIR);
  let cam: FakeCamera;
  // Subscriptions to release after each test, so idle relays don't reconnect to
  // the stopped server (isolation + no ECONNREFUSED backoff spam across tests).
  let cleanups: Array<() => void>;

  beforeEach(async () => {
    cam = new FakeCamera();
    cleanups = [];
    await cam.start(certs);
  });
  afterEach(() => {
    for (const c of cleanups.splice(0)) c();
    cam.stop();
  });

  const relayOf = (over: Partial<ConstructorParameters<typeof CameraRelay>[0]> = {}) =>
    new CameraRelay({
      host: "127.0.0.1",
      port: cam.port,
      accessCode: "code",
      lingerMs: 10_000,
      backoffBaseMs: 20,
      backoffMaxMs: 40,
      ...over,
    });

  /** subscribe + register the unsub for afterEach cleanup. */
  const sub = (relay: CameraRelay, fn: (j: Buffer) => void): (() => void) => {
    const un = relay.subscribe(fn);
    cleanups.push(un);
    return un;
  };

  test("(a) one frame fans out to every subscriber over a single upstream", async () => {
    const relay = relayOf();
    const a = collector();
    const b = collector();
    const before = cam.connections;
    const unA = sub(relay, a.onFrame);
    const unB = sub(relay, b.onFrame);
    await cam.nextConnection(); // exactly one upstream for both
    cam.broadcast();
    await Promise.all([a.waitFor(1), b.waitFor(1)]);
    expect(cam.connections).toBe(before + 1); // single connection
    expect(relay.connectCount()).toBe(1);
    expect(a.frames[0]!.equals(JPEG)).toBe(true);
    expect(b.frames[0]!.equals(JPEG)).toBe(true);
    unA();
    unB();
  });

  test("(b) after the last unsubscribe + linger, the upstream is dropped", async () => {
    const relay = relayOf({ lingerMs: 30 });
    const a = collector();
    const un = sub(relay, a.onFrame);
    await cam.nextConnection();
    cam.broadcast();
    await a.waitFor(1);
    expect(relay.isUpstreamUp()).toBe(true);
    un(); // no subscribers → linger → teardown
    await cam.nextClose();
    expect(relay.isUpstreamUp()).toBe(false);
    expect(relay.latest()).toBeNull(); // stale frame cleared on teardown
  });

  test("(c) re-subscribing within the linger window does NOT reconnect", async () => {
    const relay = relayOf({ lingerMs: 5_000 });
    const a = collector();
    const un = sub(relay, a.onFrame);
    await cam.nextConnection();
    cam.broadcast();
    await a.waitFor(1);
    expect(relay.connectCount()).toBe(1);
    un(); // schedules a long linger — upstream stays alive
    const b = collector();
    sub(relay, b.onFrame); // within the linger window
    expect(relay.connectCount()).toBe(1); // reused, no new connection
    expect(relay.isUpstreamUp()).toBe(true);
    cam.broadcast();
    await b.waitFor(1); // same upstream serves the newcomer
    expect(b.frames[0]!.equals(JPEG)).toBe(true);
  });

  test("(d) snapshot() with no frame temporarily subscribes, then lingers out", async () => {
    const relay = relayOf({ lingerMs: 30 });
    const before = cam.connections;
    const p = relay.snapshot(4_000);
    await cam.nextConnection();
    cam.broadcast();
    const buf = await p;
    expect(buf).not.toBeNull();
    expect(buf!.equals(JPEG)).toBe(true);
    expect(cam.connections).toBe(before + 1); // one capture, one connection
    await cam.nextClose(); // temporary subscriber gone → linger → teardown
    expect(relay.isUpstreamUp()).toBe(false);
  });

  test("(d2) snapshot() returns the buffered frame with no new connection", async () => {
    const relay = relayOf({ lingerMs: 5_000 });
    const a = collector();
    const un = sub(relay, a.onFrame);
    await cam.nextConnection();
    cam.broadcast();
    await a.waitFor(1);
    const before = cam.connections;
    const buf = await relay.snapshot(1_000);
    expect(buf!.equals(JPEG)).toBe(true);
    expect(cam.connections).toBe(before); // served from cache, no reconnect
    un();
  });

  test("(e) upstream death with a subscriber present triggers a reconnect", async () => {
    const relay = relayOf({ lingerMs: 10_000, backoffBaseMs: 15 });
    const a = collector();
    const un = sub(relay, a.onFrame);
    await cam.nextConnection();
    cam.broadcast();
    await a.waitFor(1);
    expect(relay.connectCount()).toBe(1);
    cam.killAll(); // upstream dies mid-stream
    await cam.nextConnection(); // relay reconnects (backoff)
    expect(relay.connectCount()).toBe(2);
    cam.broadcast();
    await a.waitFor(2); // frames flow again on the new connection
    expect(a.frames[1]!.equals(JPEG)).toBe(true);
    un();
  });

  test("relaySnapshotSource adapts a buffered frame to SnapshotFrame", async () => {
    const relay = relayOf({ lingerMs: 5_000 });
    const a = collector();
    const un = sub(relay, a.onFrame);
    await cam.nextConnection();
    cam.broadcast();
    await a.waitFor(1);
    const source = relaySnapshotSource(relay);
    const frame = await source.latest();
    expect(frame).not.toBeNull();
    expect(frame!.contentType).toBe("image/jpeg");
    expect(Buffer.from(frame!.bytes).equals(JPEG)).toBe(true);
    un();
  });

  test("a silent camera degrades snapshot() to null — never throws (spec 20.8)", async () => {
    const relay = relayOf({ lingerMs: 30 });
    const buf = await relay.snapshot(200); // no broadcast → times out
    expect(buf).toBeNull();
    await cam.nextClose(); // temporary subscriber cleaned up
  });

  test("an unreachable camera degrades snapshot() to null", async () => {
    const relay = new CameraRelay({ host: "127.0.0.1", port: 1, accessCode: "x", lingerMs: 30 });
    expect(await relay.snapshot(500)).toBeNull();
  });
});
