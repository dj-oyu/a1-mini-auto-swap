import type { Clock, Logger, LogLevel } from "../core/ports.ts";
import { systemClock } from "../core/ports.ts";
import { createLogger } from "./logger.ts";
import { ConsoleSink, RotatingFileSink, type ConsoleFormat } from "./sinks.ts";
import { setLogger } from "./default-logger.ts";

// Runtime logging composition (obs). Reads env, wires the console + rotating
// file sinks, installs the process-wide logger, and returns everything a
// composition root needs (main / harness / stub). Pure factories live in
// logger.ts / sinks.ts; this is the only file that touches process.env.

export interface RuntimeLoggerConfig {
  level: LogLevel;
  format: ConsoleFormat;
  retentionDays: number;
  mqttLog: boolean;
  logDir: string;
  mqttLogDir: string;
}

export interface RuntimeLogger {
  /** App log (stream 1): console + data/logs/app-*.jsonl. Also installed as the
   *  process-wide default (setLogger), so module loggers route here. */
  appLogger: Logger;
  /** State-transition log (stream 2): console + data/logs/state-*.jsonl. */
  stateLogger: Logger;
  /** Effective config (for the startup banner + tests). */
  config: RuntimeLoggerConfig;
}

const LEVELS: readonly LogLevel[] = ["debug", "info", "warn", "error"];

export function readLoggerConfig(env: NodeJS.ProcessEnv = process.env): RuntimeLoggerConfig {
  const rawLevel = (env.LOG_LEVEL ?? "info").toLowerCase();
  const level: LogLevel = (LEVELS as readonly string[]).includes(rawLevel) ? (rawLevel as LogLevel) : "info";
  // Default: pretty for interactive dev, JSON in production (structured ingest).
  const rawFormat = (env.LOG_FORMAT ?? (env.NODE_ENV === "production" ? "json" : "pretty")).toLowerCase();
  const format: ConsoleFormat = rawFormat === "json" ? "json" : "pretty";
  const retentionRaw = Number(env.LOG_RETENTION_DAYS ?? 14);
  const retentionDays = Number.isFinite(retentionRaw) && retentionRaw >= 0 ? retentionRaw : 14;
  const mqttLog = env.MQTT_LOG === "1";
  const logDir = env.LOG_DIR ?? "./data/logs";
  const mqttLogDir = env.MQTT_LOG_DIR ?? "./data/mqtt-log";
  return { level, format, retentionDays, mqttLog, logDir, mqttLogDir };
}

export interface CreateRuntimeLoggerOptions {
  /** service binding stamped on every record (e.g. "orchestrator"). */
  service: string;
  clock?: Clock;
  env?: NodeJS.ProcessEnv;
  /** Install as the process-wide logger (default true). */
  install?: boolean;
}

/** Build + install the runtime loggers from env. */
export function createRuntimeLogger(opts: CreateRuntimeLoggerOptions): RuntimeLogger {
  const clock = opts.clock ?? systemClock;
  const config = readLoggerConfig(opts.env);

  const console = new ConsoleSink(config.format);
  const appFile = new RotatingFileSink({
    dir: config.logDir,
    prefix: "app",
    clock,
    retentionDays: config.retentionDays,
  });
  const stateFile = new RotatingFileSink({
    dir: config.logDir,
    prefix: "state",
    clock,
    retentionDays: config.retentionDays,
  });

  const appLogger = createLogger({
    level: config.level,
    clock,
    sinks: [console, appFile],
    base: { service: opts.service },
  });
  // State stream is low-volume + always on: never filtered out by LOG_LEVEL,
  // and it goes to its own file so a filament-runout investigation greps one
  // small trail. Console mirrors it (also low volume).
  const stateLogger = createLogger({
    level: "debug",
    clock,
    sinks: [console, stateFile],
    base: { service: opts.service, stream: "state" },
  });

  if (opts.install !== false) setLogger(appLogger);
  return { appLogger, stateLogger, config };
}
