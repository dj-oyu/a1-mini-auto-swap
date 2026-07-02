import { Hono } from "hono";

/**
 * Camera snapshot API (spec ch8 / spec 17 §5: "物理世界が真実" — カメラを1タップで).
 * `GET /api/printer/snapshot` returns the latest camera frame so the UI can show
 * the bed on demand. The frame comes from a source (structural): the real A1
 * capture (orchestrator/camera.ts, port-6000 chamber protocol — 実測 2026-07-02)
 * or the dev harness placeholder. `latest()` may be async (the real capture
 * connects on demand, ~3s to first frame).
 */

export interface SnapshotFrame {
  contentType: string; // e.g. "image/jpeg"
  bytes: Uint8Array;
}
export interface SnapshotSource {
  latest(): SnapshotFrame | null | Promise<SnapshotFrame | null>;
}

export function createSnapshotApp(deps: { source: SnapshotSource }): Hono {
  const app = new Hono();

  app.get("/api/printer/snapshot", async (c) => {
    const frame = await deps.source.latest();
    if (!frame) return c.json({ error: "no snapshot available" }, 404);
    c.header("content-type", frame.contentType);
    c.header("cache-control", "no-store"); // always fetch the freshest frame
    return c.body(frame.bytes as Uint8Array<ArrayBuffer>);
  });

  return app;
}
