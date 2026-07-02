import { describe, expect, test } from "bun:test";
import { createSnapshotApp, type SnapshotSource } from "../../src/api/snapshot-routes.ts";

const frameSource = (bytes: Uint8Array): SnapshotSource => ({
  latest: () => ({ contentType: "image/png", bytes }),
});

describe("GET /api/printer/snapshot", () => {
  test("serves the latest frame with its content-type + no-store", async () => {
    const png = new Uint8Array([1, 2, 3, 4]);
    const app = createSnapshotApp({ source: frameSource(png) });
    const res = await app.request("/api/printer/snapshot");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("cache-control")).toContain("no-store");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(png);
  });

  test("404s when no frame is available", async () => {
    const app = createSnapshotApp({ source: { latest: () => null } });
    expect((await app.request("/api/printer/snapshot")).status).toBe(404);
  });
});
