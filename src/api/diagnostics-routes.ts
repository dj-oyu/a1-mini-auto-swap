import { Hono } from "hono";
import { runDiagnostics, type DiagnosticsOptions, type DiagnosticsResult } from "../orchestrator/diagnostics.ts";

/**
 * `GET /api/diagnostics` (spec 20.7): run the connectivity probe against the
 * configured printer target and return the structured verdict as one JSON
 * response. Runs the same logic against the stub or a real A1 mini, so Phase 8
 * cutover can be triaged quickly. The check takes a few seconds; a single JSON
 * response (no streaming) is fine per spec.
 *
 * The target config is injected (never read from the environment here), and the
 * runner is injectable so the route can be tested without real I/O.
 */
export interface DiagnosticsAppDeps {
  target: DiagnosticsOptions;
  run?: (opts: DiagnosticsOptions) => Promise<DiagnosticsResult>;
}

export function createDiagnosticsApp(deps: DiagnosticsAppDeps): Hono {
  const run = deps.run ?? runDiagnostics;
  const app = new Hono();

  app.get("/api/diagnostics", async (c) => {
    const result = await run(deps.target);
    return c.json(result);
  });

  return app;
}
