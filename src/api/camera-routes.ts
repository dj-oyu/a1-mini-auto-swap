import { Hono } from "hono";
import type { FrameRelay } from "../orchestrator/camera-relay.ts";

/**
 * Live camera stream (spec 17 §5). `GET /api/printer/camera.mjpeg` is an
 * `multipart/x-mixed-replace` MJPEG stream an <img> can point at directly — the
 * browser swaps in each new JPEG part (~1fps). It subscribes to the shared
 * CameraRelay, so however many tabs open the modal, the printer sees at most one
 * upstream camera connection. On client disconnect the ReadableStream cancels
 * and we unsubscribe (a leaked subscriber would pin the scarce upstream slot
 * open forever), so the relay's linger can release the upstream.
 *
 * Streaming follows the SSE route's Bun pattern (sse-notifier.open): register
 * the writer in start(), remove it in cancel(). Best-effort — a write to a gone
 * client just unsubscribes; nothing is thrown into the relay.
 */

const BOUNDARY = "a1frameboundary";

export function createCameraApp(deps: { relay: FrameRelay }): Hono {
  const app = new Hono();

  app.get("/api/printer/camera.mjpeg", () => {
    const enc = new TextEncoder();
    let unsubscribe: (() => void) | undefined;
    const stop = () => {
      unsubscribe?.();
      unsubscribe = undefined;
    };
    const stream = new ReadableStream<Uint8Array>({
      start: (controller) => {
        const send = (jpeg: Buffer) => {
          try {
            controller.enqueue(
              enc.encode(
                `--${BOUNDARY}\r\nContent-Type: image/jpeg\r\nContent-Length: ${jpeg.length}\r\n\r\n`,
              ),
            );
            controller.enqueue(new Uint8Array(jpeg.buffer, jpeg.byteOffset, jpeg.byteLength));
            controller.enqueue(enc.encode("\r\n"));
          } catch {
            // Controller closed (client gone before cancel fired) — stop feeding.
            stop();
          }
        };
        unsubscribe = deps.relay.subscribe(send);
      },
      cancel: () => stop(),
    });

    return new Response(stream, {
      headers: {
        "content-type": `multipart/x-mixed-replace; boundary=${BOUNDARY}`,
        "cache-control": "no-store, no-cache, must-revalidate",
        pragma: "no-cache",
        connection: "keep-alive",
      },
    });
  });

  return app;
}
