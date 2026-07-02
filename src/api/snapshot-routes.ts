import { Hono } from "hono";

/**
 * Camera snapshot API (spec ch8 / spec 17 §5: "物理世界が真実" — カメラを1タップで).
 * `GET /api/printer/snapshot` returns the latest camera frame so the UI can show
 * the bed on demand. The frame comes from a source (structural) — the real A1
 * mini camera capture is hardware-dependent and unverified, so main() wires a
 * source that returns null (→404) until implemented; the dev harness supplies a
 * placeholder so the UI/flow are exercisable.
 */

export interface SnapshotFrame {
  contentType: string; // e.g. "image/jpeg"
  bytes: Uint8Array;
}
export interface SnapshotSource {
  latest(): SnapshotFrame | null;
}

export function createSnapshotApp(deps: { source: SnapshotSource }): Hono {
  const app = new Hono();

  app.get("/api/printer/snapshot", (c) => {
    const frame = deps.source.latest();
    if (!frame) return c.json({ error: "no snapshot available" }, 404);
    c.header("content-type", frame.contentType);
    c.header("cache-control", "no-store"); // always fetch the freshest frame
    return c.body(frame.bytes as Uint8Array<ArrayBuffer>);
  });

  return app;
}
