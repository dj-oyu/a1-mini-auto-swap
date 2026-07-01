import { describe, expect, test } from "bun:test";
import { SseBroadcaster, formatFrame } from "../../src/orchestrator/sse-notifier.ts";

describe("SseBroadcaster", () => {
  test("formatFrame emits a named SSE event with the JSON payload", () => {
    const frame = formatFrame({ type: "job_finished", jobId: 7 });
    expect(frame).toBe(`event: job_finished\ndata: ${JSON.stringify({ type: "job_finished", jobId: 7 })}\n\n`);
    expect(frame.endsWith("\n\n")).toBe(true); // SSE frames are blank-line terminated
  });

  test("fans a notify out to every subscribed client", () => {
    const b = new SseBroadcaster();
    const a: string[] = [];
    const c: string[] = [];
    b.subscribe((f) => a.push(f));
    b.subscribe((f) => c.push(f));

    b.notify({ type: "pending_action", jobId: 1, severity: "blocking_job" });

    expect(a).toHaveLength(1);
    expect(c).toHaveLength(1);
    expect(a[0]).toContain("event: pending_action");
  });

  test("unsubscribe stops delivery and updates the client count", () => {
    const b = new SseBroadcaster();
    const received: string[] = [];
    const off = b.subscribe((f) => received.push(f));
    expect(b.clientCount()).toBe(1);

    off();
    expect(b.clientCount()).toBe(0);
    b.notify({ type: "timeout" });
    expect(received).toHaveLength(0);
  });

  test("a throwing client is dropped, not propagated to the caller or peers", () => {
    const b = new SseBroadcaster();
    const good: string[] = [];
    b.subscribe(() => {
      throw new Error("client gone");
    });
    b.subscribe((f) => good.push(f));

    expect(() => b.notify({ type: "job_failed", jobId: 2 })).not.toThrow();
    expect(good).toHaveLength(1); // healthy peer still delivered
    expect(b.clientCount()).toBe(1); // dead client pruned
  });

  test("sendProgress emits an event: progress frame with the JSON payload", () => {
    const b = new SseBroadcaster();
    const frames: string[] = [];
    b.subscribe((f) => frames.push(f));
    b.sendProgress({ printing: true, job_id: 3, percent: 88, remaining_min: 5 });
    expect(frames).toHaveLength(1);
    expect(frames[0]).toContain("event: progress");
    expect(frames[0]).toContain('"percent":88');
    expect(frames[0]!.endsWith("\n\n")).toBe(true);
  });

  test("open() returns an SSE Response and registers a client", () => {
    const b = new SseBroadcaster();
    const res = b.open();
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    expect(b.clientCount()).toBe(1);
  });

  test("open() streams the initial comment then a pushed event", async () => {
    const b = new SseBroadcaster();
    const res = b.open();
    const reader = res.body!.getReader();
    const dec = new TextDecoder();

    const first = await reader.read();
    expect(dec.decode(first.value)).toContain(": connected");

    b.notify({ type: "job_finished", jobId: 42 });
    const second = await reader.read();
    const text = dec.decode(second.value);
    expect(text).toContain("event: job_finished");
    expect(text).toContain('"jobId":42');

    await reader.cancel();
  });

  test("cancelling the stream unsubscribes the client", async () => {
    const b = new SseBroadcaster();
    const res = b.open();
    expect(b.clientCount()).toBe(1);
    await res.body!.cancel();
    expect(b.clientCount()).toBe(0);
  });
});
