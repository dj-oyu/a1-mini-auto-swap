import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Clock } from "../../src/core/ports.ts";
import { createLogger } from "../../src/obs/logger.ts";
import { RotatingFileSink } from "../../src/obs/sinks.ts";
import { REDACTED } from "../../src/obs/redact.ts";

// Smoke test: proves pino.multistream actually writes to a real file under Bun
// (the entire reason we avoid worker-thread transports). Write a record through
// createLogger → RotatingFileSink, then read the file back off disk and parse it.

const FIXED = Date.parse("2026-07-03T08:00:00Z");
const clock: Clock = { now: () => FIXED };

describe("logger smoke: real write-and-read-back under Bun", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "obs-smoke-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("a record logged through a file sink lands on disk as a parseable JSON line", () => {
    const sink = new RotatingFileSink({ dir, prefix: "app", clock, retentionDays: 0 });
    const log = createLogger({
      level: "info",
      sinks: [sink],
      clock,
      base: { service: "orchestrator" },
    });

    log.info("job dispatched", { jobId: 42, filename: "plate_03.gcode.3mf", accessCode: "12345678" });

    const file = join(dir, "app-2026-07-03.jsonl");
    const contents = readFileSync(file, "utf8");
    const lines = contents.trim().split("\n");
    expect(lines).toHaveLength(1);

    const rec = JSON.parse(lines[0]!) as Record<string, unknown>;
    expect(rec.msg).toBe("job dispatched");
    expect(rec.level).toBe("info");
    expect(rec.time).toBe(FIXED);
    expect(rec.service).toBe("orchestrator");
    expect(rec.jobId).toBe(42);
    expect(rec.filename).toBe("plate_03.gcode.3mf");
    // Secret must never reach disk.
    expect(rec.accessCode).toBe(REDACTED);
    expect(contents).not.toContain("12345678");
  });
});
