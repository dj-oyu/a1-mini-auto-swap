import { describe, expect, test } from "bun:test";
import { CompositeNotifier } from "../../src/core/composite-notifier.ts";
import type { Notifier, NotifyEvent } from "../../src/core/ports.ts";

class Rec implements Notifier {
  events: NotifyEvent[] = [];
  notify(e: NotifyEvent): void {
    this.events.push(e);
  }
}
class Throwing implements Notifier {
  notify(): void {
    throw new Error("boom");
  }
}

describe("CompositeNotifier", () => {
  test("fans out to every notifier", () => {
    const a = new Rec();
    const b = new Rec();
    const ev: NotifyEvent = { type: "job_finished", jobId: 1 };
    new CompositeNotifier([a, b]).notify(ev);
    expect(a.events).toEqual([ev]);
    expect(b.events).toEqual([ev]);
  });

  test("one throwing notifier does not stop the others or bubble up", () => {
    const good = new Rec();
    const composite = new CompositeNotifier([new Throwing(), good]);
    expect(() => composite.notify({ type: "job_failed", jobId: 2 })).not.toThrow();
    expect(good.events).toHaveLength(1);
  });
});
