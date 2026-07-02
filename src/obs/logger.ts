import pino from "pino";
import type { Clock, Logger, LogFields, LogLevel } from "../core/ports.ts";
import { systemClock } from "../core/ports.ts";
import { redactFields } from "./redact.ts";
import type { LogSink } from "./sinks.ts";

// pino-backed Logger adapter (obs stream 1: the always-on structured app log).
//
// Bun compatibility: pino's worker-thread transports (pino/file, pino-pretty)
// are unstable under Bun, so we NEVER use `transport`. Instead we drive pino
// with `pino.multistream` over our own synchronous JS sinks (obs/sinks.ts) —
// pure JS, no workers. Verified to actually write under Bun by
// test/obs/logger.smoke.test.ts (writes a temp file and reads it back).
//
// Determinism: the record timestamp comes from the injected Clock, so a
// FakeClock pins `time` in tests. Redaction runs in-adapter (redact.ts) before
// anything reaches pino, so secrets can't leak into any sink.

const LEVEL_VALUE: Record<LogLevel, number> = { debug: 20, info: 30, warn: 40, error: 50 };

export interface CreateLoggerOptions {
  /** Minimum level emitted (default "info"). */
  level?: LogLevel;
  /** Timestamp source (default systemClock). */
  clock?: Clock;
  /** Destinations. Each receives every record at/above `level`. */
  sinks: LogSink[];
  /** Root bindings stamped on every record (e.g. { service: "orchestrator" }). */
  base?: LogFields;
}

/** Build a root Logger over the given sinks. */
export function createLogger(opts: CreateLoggerOptions): Logger {
  const level = opts.level ?? "info";
  const clock = opts.clock ?? systemClock;
  const streams = opts.sinks.map((sink) => ({ level, stream: sink as pino.DestinationStream }));
  const p = pino(
    {
      level,
      base: undefined, // no pid/hostname — keep records clean and host-agnostic
      timestamp: () => `,"time":${clock.now()}`,
      formatters: { level: (label: string) => ({ level: label }) },
    },
    pino.multistream(streams, { levels: LEVEL_VALUE }),
  );
  const root = opts.base ? p.child(redactFields(opts.base)) : p;
  return new PinoLogger(root);
}

class PinoLogger implements Logger {
  constructor(private readonly p: pino.Logger) {}

  debug(msg: string, fields?: LogFields): void {
    this.p.debug(fields ? redactFields(fields) : {}, msg);
  }
  info(msg: string, fields?: LogFields): void {
    this.p.info(fields ? redactFields(fields) : {}, msg);
  }
  warn(msg: string, fields?: LogFields): void {
    this.p.warn(fields ? redactFields(fields) : {}, msg);
  }
  error(msg: string, fields?: LogFields): void {
    this.p.error(fields ? redactFields(fields) : {}, msg);
  }
  child(bindings: LogFields): Logger {
    return new PinoLogger(this.p.child(redactFields(bindings)));
  }
}
