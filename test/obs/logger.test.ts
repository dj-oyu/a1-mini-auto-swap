import { describe, expect, test } from "bun:test";
import type { Clock } from "../../src/core/ports.ts";
import { createLogger } from "../../src/obs/logger.ts";
import { MemorySink } from "../../src/obs/sinks.ts";
import { REDACTED } from "../../src/obs/redact.ts";

const FIXED = 1_700_000_000_000;
const fakeClock: Clock = { now: () => FIXED };

describe("createLogger (pino over MemorySink)", () => {
  test("filters below the configured level (debug suppressed at info)", () => {
    const mem = new MemorySink();
    const log = createLogger({ level: "info", sinks: [mem], clock: fakeClock });
    log.debug("hidden");
    log.info("shown");
    log.warn("also shown");
    const msgs = mem.records().map((r) => r.msg);
    expect(msgs).toEqual(["shown", "also shown"]);
  });

  test("debug level lets debug through", () => {
    const mem = new MemorySink();
    const log = createLogger({ level: "debug", sinks: [mem], clock: fakeClock });
    log.debug("dbg");
    expect(mem.records()[0]!.msg).toBe("dbg");
    expect(mem.records()[0]!.level).toBe("debug");
  });

  test("injected clock pins the record time", () => {
    const mem = new MemorySink();
    const log = createLogger({ level: "info", sinks: [mem], clock: fakeClock });
    log.info("tick");
    expect(mem.records()[0]!.time).toBe(FIXED);
  });

  test("base bindings are stamped on every record", () => {
    const mem = new MemorySink();
    const log = createLogger({
      level: "info",
      sinks: [mem],
      clock: fakeClock,
      base: { service: "orchestrator" },
    });
    log.info("a");
    log.info("b");
    expect(mem.records().every((r) => r.service === "orchestrator")).toBe(true);
  });

  test("child() merges bindings with the parent's", () => {
    const mem = new MemorySink();
    const log = createLogger({
      level: "info",
      sinks: [mem],
      clock: fakeClock,
      base: { service: "orchestrator" },
    });
    const child = log.child({ mod: "ftps" });
    child.info("uploading", { file: "x.3mf" });
    const rec = mem.records()[0]!;
    expect(rec.service).toBe("orchestrator");
    expect(rec.mod).toBe("ftps");
    expect(rec.file).toBe("x.3mf");
    expect(rec.msg).toBe("uploading");
  });

  test("redacts secret fields in message fields", () => {
    const mem = new MemorySink();
    const log = createLogger({ level: "info", sinks: [mem], clock: fakeClock });
    log.info("connect", { host: "controller", accessCode: "12345678" });
    const rec = mem.records()[0]!;
    expect(rec.host).toBe("controller");
    expect(rec.accessCode).toBe(REDACTED);
  });

  test("redacts secret fields in base bindings", () => {
    const mem = new MemorySink();
    const log = createLogger({
      level: "info",
      sinks: [mem],
      clock: fakeClock,
      base: { service: "orchestrator", token: "sk-secret" },
    });
    log.info("x");
    const rec = mem.records()[0]!;
    expect(rec.service).toBe("orchestrator");
    expect(rec.token).toBe(REDACTED);
  });

  test("redacts secret fields in child bindings", () => {
    const mem = new MemorySink();
    const log = createLogger({ level: "info", sinks: [mem], clock: fakeClock });
    const child = log.child({ mod: "webhook", webhookUrl: "https://discord.com/api/webhooks/a/b" });
    child.info("posting");
    const rec = mem.records()[0]!;
    expect(rec.mod).toBe("webhook");
    expect(rec.webhookUrl).toBe(REDACTED);
  });

  test("fans out to multiple sinks", () => {
    const a = new MemorySink();
    const b = new MemorySink();
    const log = createLogger({ level: "info", sinks: [a, b], clock: fakeClock });
    log.info("dup");
    expect(a.records()[0]!.msg).toBe("dup");
    expect(b.records()[0]!.msg).toBe("dup");
  });
});
