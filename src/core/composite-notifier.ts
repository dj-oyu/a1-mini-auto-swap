import type { Notifier, NotifyEvent } from "./ports.ts";

/**
 * Fans a notification out to several notifiers (e.g. a Discord webhook + the
 * self-hosted MQTT republish gateway). One notifier throwing must not stop the
 * others or bubble into the caller (notifications are best-effort).
 */
export class CompositeNotifier implements Notifier {
  constructor(private readonly notifiers: Notifier[]) {}

  notify(event: NotifyEvent): void {
    for (const n of this.notifiers) {
      try {
        n.notify(event);
      } catch {
        // best-effort: never let one sink break the others or the caller
      }
    }
  }
}
