import { Hono } from "hono";
import type { SseBroadcaster } from "../orchestrator/sse-notifier.ts";

/**
 * SSE endpoint (spec 17 / docs/ui-handoff.md §3): `GET /events` streams every
 * NotifyEvent to connected browsers. Thin — all the fan-out lives in the
 * SseBroadcaster (a Notifier adapter); this only exposes it over HTTP. Returned
 * as a Hono app so it mounts alongside the other routes and is testable via
 * `app.request("/events")`.
 */
export function createEventsApp(broadcaster: SseBroadcaster): Hono {
  const app = new Hono();
  app.get("/events", () => broadcaster.open());
  return app;
}
