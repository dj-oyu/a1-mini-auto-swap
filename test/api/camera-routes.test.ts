// GET /api/printer/camera.mjpeg (api/camera-routes.ts) — the MJPEG relay stream.
// Driven with a fake FrameRelay so no socket/printer is involved: we assert the
// multipart headers + first part framing, and that a client disconnect (stream
// cancel) unsubscribes from the relay (a leak would pin the single upstream slot).
import { describe, expect, test } from "bun:test";
import { createCameraApp } from "../../src/api/camera-routes.ts";
import type { FrameRelay } from "../../src/orchestrator/camera-relay.ts";

const JPEG = Buffer.concat([
  Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
  Buffer.alloc(120, 0x33),
  Buffer.from([0xff, 0xd9]),
]);

function fakeRelay() {
  const listeners = new Set<(j: Buffer) => void>();
  let unsub = 0;
  const relay: FrameRelay & {
    emit: (j: Buffer) => void;
    listenerCount: () => number;
    unsubCalls: () => number;
  } = {
    subscribe(on) {
      listeners.add(on);
      return () => {
        unsub++;
        listeners.delete(on);
      };
    },
    latest: () => null,
    snapshot: async () => null,
    emit: (j) => {
      for (const l of [...listeners]) l(j);
    },
    listenerCount: () => listeners.size,
    unsubCalls: () => unsub,
  };
  return relay;
}

describe("GET /api/printer/camera.mjpeg", () => {
  test("responds with a multipart/x-mixed-replace MJPEG stream", async () => {
    const relay = fakeRelay();
    const res = await createCameraApp({ relay }).request("/api/printer/camera.mjpeg");
    expect(res.status).toBe(200);
    const ct = res.headers.get("content-type") ?? "";
    expect(ct).toContain("multipart/x-mixed-replace");
    expect(ct).toContain("boundary=");
    expect(res.headers.get("cache-control")).toContain("no-store");
    await res.body?.cancel(); // release the stream
  });

  test("subscribes on open and writes a well-formed part per frame", async () => {
    const relay = fakeRelay();
    const res = await createCameraApp({ relay }).request("/api/printer/camera.mjpeg");
    expect(relay.listenerCount()).toBe(1); // subscribed during stream start()

    const reader = res.body!.getReader();
    relay.emit(JPEG);

    // First chunk is the part header: boundary + content-type + content-length.
    const first = await reader.read();
    const head = Buffer.from(first.value!).toString("latin1");
    expect(head).toContain("--a1frameboundary");
    expect(head).toContain("Content-Type: image/jpeg");
    expect(head).toContain(`Content-Length: ${JPEG.length}`);

    // Second chunk is the JPEG payload itself.
    const body = await reader.read();
    expect(Buffer.from(body.value!).equals(JPEG)).toBe(true);

    await reader.cancel();
  });

  test("client disconnect (stream cancel) unsubscribes — no leaked upstream", async () => {
    const relay = fakeRelay();
    const res = await createCameraApp({ relay }).request("/api/printer/camera.mjpeg");
    expect(relay.listenerCount()).toBe(1);

    await res.body!.cancel(); // simulate the browser closing the connection
    expect(relay.unsubCalls()).toBe(1);
    expect(relay.listenerCount()).toBe(0);
  });
});
