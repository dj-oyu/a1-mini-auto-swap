import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Clock } from "../../src/core/ports.ts";
import { createLogger } from "../../src/obs/logger.ts";
import { MemorySink } from "../../src/obs/sinks.ts";
import { StateLog, type ReportSource } from "../../src/orchestrator/state-log.ts";
import { ReportRecorder } from "../../src/orchestrator/report-recorder.ts";
import { createRuntimeLogger } from "../../src/obs/index.ts";

// Part A wiring: prove the audit recorders actually fire when driven off the
// SAME event shape the OrchestratorMqttClient emits — a Node EventEmitter's
// `emit("report", raw)` → `on/off("report", …)`. main.ts wires
// `new StateLog(mqtt, stateLogger).start()` (always) and, under MQTT_LOG=1,
// `new ReportRecorder(mqtt, …).start()`; these tests exercise that same hook.

const clock: Clock = { now: () => Date.parse("2026-07-03T08:00:00Z") };

describe("StateLog wiring (drives off a real EventEmitter 'report')", () => {
  test("a report event emits a state_change record; a no-change repeat is suppressed", () => {
    const mqtt = new EventEmitter() as EventEmitter & ReportSource;
    const mem = new MemorySink();
    const log = createLogger({ level: "debug", sinks: [mem], clock });
    const stateLog = new StateLog(mqtt, log);
    stateLog.start(); // subscribes to "report"

    mqtt.emit("report", { gcode_state: "RUNNING", print_error: 0, hms: [] });
    let changes = mem.records().filter((r) => r.event === "state_change");
    expect(changes).toHaveLength(1);
    expect(changes[0]!.to).toBe("RUNNING");

    // Same meaningful state → the hook fired but suppressed (no new line).
    mqtt.emit("report", { gcode_state: "RUNNING", print_error: 0, hms: [], mc_percent: 55 });
    changes = mem.records().filter((r) => r.event === "state_change");
    expect(changes).toHaveLength(1);

    // A real transition → a second record.
    mqtt.emit("report", { gcode_state: "PAUSE", print_error: 0x0500c010, hms: [{ code: 0x03000002 }] });
    changes = mem.records().filter((r) => r.event === "state_change");
    expect(changes).toHaveLength(2);
    expect(changes[1]!.from).toBe("RUNNING");
    expect(changes[1]!.to).toBe("PAUSE");
    expect(changes[1]!.print_error_hex).toBe("0x0500C010");

    stateLog.stop(); // off("report") — the shutdown path
    mqtt.emit("report", { gcode_state: "FINISH", print_error: 0, hms: [] });
    expect(mem.records().filter((r) => r.event === "state_change")).toHaveLength(2);
  });
});

describe("ReportRecorder wiring (MQTT_LOG=1 firehose)", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "audit-rec-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test("a report event appends a verbatim raw line to the dated dump", () => {
    const mqtt = new EventEmitter() as EventEmitter & ReportSource;
    const rec = new ReportRecorder(mqtt, { dir, clock, retentionDays: 0 });
    rec.start();
    mqtt.emit("report", { gcode_state: "RUNNING", mc_percent: 10, subtask_name: "job-7" });

    const file = join(dir, "2026-07-03.jsonl");
    expect(existsSync(file)).toBe(true);
    const line = readFileSync(file, "utf8").trim();
    const parsed = JSON.parse(line) as Record<string, unknown>;
    expect(parsed.ts).toBe(clock.now());
    expect(parsed.gcode_state).toBe("RUNNING");
    expect(parsed.subtask_name).toBe("job-7");
  });
});

describe("createRuntimeLogger dir-creation (why data/logs must not stay empty)", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "runtime-log-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test("the first app log creates app-<date>.jsonl on disk (RotatingFileSink path)", () => {
    const { appLogger, stateLogger } = createRuntimeLogger({
      service: "orchestrator",
      clock,
      env: { LOG_DIR: dir, LOG_FORMAT: "json", LOG_LEVEL: "info" } as NodeJS.ProcessEnv,
      install: false, // don't clobber the process-wide logger in the test runner
    });

    // Before any log the file does not exist yet (lazy creation) — this is WHY an
    // idle boot that never logs leaves data/logs empty. main.ts now emits a boot
    // record so the file appears immediately.
    const appFile = join(dir, "app-2026-07-03.jsonl");
    expect(existsSync(appFile)).toBe(false);

    appLogger.info("orchestrator started", { event: "boot", httpPort: 3000 });
    expect(existsSync(appFile)).toBe(true);
    const rec = JSON.parse(readFileSync(appFile, "utf8").trim()) as Record<string, unknown>;
    expect(rec.msg).toBe("orchestrator started");
    expect(rec.event).toBe("boot");
    expect(rec.service).toBe("orchestrator");

    stateLogger.info("state_change", { event: "state_change", to: "RUNNING" });
    const stateFile = join(dir, "state-2026-07-03.jsonl");
    expect(existsSync(stateFile)).toBe(true);
    expect(readFileSync(stateFile, "utf8")).toContain("state_change");
  });
});
