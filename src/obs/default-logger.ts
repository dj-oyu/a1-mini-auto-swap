import type { Logger, LogFields } from "../core/ports.ts";

// Module-scoped default logger. I/O adapters that aren't handed a Logger by the
// composition root (mqtt-client, ftps-session, monitor, gateway, printer,
// dispatch kick, …) log through `moduleLogger("<mod>")`. It follows whatever the
// composition root installs via `setLogger()`, and defaults to a NO-OP so unit
// tests stay quiet and never depend on console output. A test can swap in a
// MemorySink-backed logger with `setLogger()` and observe records.

export const noopLogger: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child() {
    return noopLogger;
  },
};

let current: Logger = noopLogger;

/** Install the process-wide logger (composition roots: main / harness / stub). */
export function setLogger(logger: Logger): void {
  current = logger;
}

/** Reset to the no-op logger (test teardown). */
export function resetLogger(): void {
  current = noopLogger;
}

/** The current process-wide logger. */
export function getLogger(): Logger {
  return current;
}

/**
 * A stable Logger bound to `{ mod }` that always delegates to the *current*
 * process-wide logger — so `setLogger()` after module load still takes effect.
 * The child is cached until the underlying logger is swapped.
 */
export function moduleLogger(mod: string): Logger {
  let cachedFrom: Logger | null = null;
  let cachedChild: Logger = noopLogger;
  const bound = (): Logger => {
    if (cachedFrom !== current) {
      cachedChild = current.child({ mod });
      cachedFrom = current;
    }
    return cachedChild;
  };
  return {
    debug: (m: string, f?: LogFields) => bound().debug(m, f),
    info: (m: string, f?: LogFields) => bound().info(m, f),
    warn: (m: string, f?: LogFields) => bound().warn(m, f),
    error: (m: string, f?: LogFields) => bound().error(m, f),
    child: (b: LogFields) => bound().child(b),
  };
}
