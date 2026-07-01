import type { Notifier, NotifyEvent } from "../core/ports.ts";

/**
 * Server-Sent-Events fan-out (spec 17 / docs/ui-handoff.md §3). A concrete
 * Notifier adapter: every event the core loop emits through `notify()` (via the
 * CompositeNotifier, alongside the webhook + MQTT gateway) is pushed to all
 * connected browsers as an SSE frame. This is the live-update foundation — the
 * dashboard subscribes to `/events` and refreshes when anything changes.
 *
 * No timers here (determinism, per CLAUDE.md): the broadcaster only reacts to
 * notify() and to client connect/disconnect. Best-effort like the other sinks —
 * a dead client is dropped, never thrown into the caller.
 */

type Send = (frame: string) => void;

export class SseBroadcaster implements Notifier {
  private readonly clients = new Set<Send>();

  /** Port method: push the event to every connected client. Never throws. */
  notify(event: NotifyEvent): void {
    const frame = formatFrame(event);
    for (const send of [...this.clients]) {
      try {
        send(frame);
      } catch {
        this.clients.delete(send); // client gone; stop tracking it
      }
    }
  }

  /** Register a raw writer; returns an unsubscribe fn. Exposed for tests and
   *  used by open() to back an HTTP stream. */
  subscribe(send: Send): () => void {
    this.clients.add(send);
    return () => this.clients.delete(send);
  }

  clientCount(): number {
    return this.clients.size;
  }

  /** Open an SSE stream for one client, ready to serve from `GET /events`. The
   *  writer is registered on connect and removed when the client disconnects
   *  (stream cancel). An initial comment flushes headers immediately. */
  open(): Response {
    const enc = new TextEncoder();
    let unsubscribe: (() => void) | undefined;
    const stream = new ReadableStream<Uint8Array>({
      start: (controller) => {
        unsubscribe = this.subscribe((frame) => controller.enqueue(enc.encode(frame)));
        controller.enqueue(enc.encode(": connected\n\n"));
      },
      cancel: () => unsubscribe?.(),
    });
    return new Response(stream, {
      headers: {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache",
        connection: "keep-alive",
      },
    });
  }
}

/** SSE wire format: a named event so the browser can addEventListener(type),
 *  with the full NotifyEvent as JSON in the data line. */
export function formatFrame(event: NotifyEvent): string {
  return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}
