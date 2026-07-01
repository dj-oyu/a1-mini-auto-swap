import { describe, expect, test } from "bun:test";
import { createEventsApp } from "../../src/api/events-routes.ts";
import { SseBroadcaster } from "../../src/orchestrator/sse-notifier.ts";

describe("GET /events (SSE)", () => {
  test("responds with an event-stream", async () => {
    const broadcaster = new SseBroadcaster();
    const app = createEventsApp(broadcaster);
    const res = await app.request("/events");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    await res.body!.cancel();
  });

  test("delivers a notify pushed after the client connected", async () => {
    const broadcaster = new SseBroadcaster();
    const app = createEventsApp(broadcaster);
    const res = await app.request("/events");
    const reader = res.body!.getReader();
    const dec = new TextDecoder();

    await reader.read(); // initial ": connected" comment
    expect(broadcaster.clientCount()).toBe(1);

    broadcaster.notify({ type: "waiting_for_refill", severity: "blocking_queue" });
    const chunk = await reader.read();
    const text = dec.decode(chunk.value);
    expect(text).toContain("event: waiting_for_refill");
    expect(text).toContain('"severity":"blocking_queue"');

    await reader.cancel();
  });
});
