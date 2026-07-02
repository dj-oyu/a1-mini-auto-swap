import type { LogFields } from "../core/ports.ts";

// Secret redaction for structured logs. This repo is PUBLIC and the controller
// host talks to a real printer, a Discord/Slack webhook, and (optionally) a
// fixed API token — none of which may ever land in a log file. We redact by
// KEY NAME (case-insensitive substring), recursively, before a record reaches
// pino, so a careless `log.info("x", { accessCode })` can never leak.

export const REDACTED = "[REDACTED]";

/** Key-name fragments (lowercased) that mark a value as secret. Substring match
 *  so `accessCode`, `access_code`, `PRINTER_ACCESS_CODE`, `discordWebhookUrl`,
 *  `authToken`, `Authorization` are all caught. */
const SECRET_KEY_FRAGMENTS = [
  "accesscode",
  "access_code",
  "password",
  "passwd",
  "secret",
  "token",
  "webhook",
  "authorization",
  "apikey",
  "api_key",
  "credential",
];

function isSecretKey(key: string): boolean {
  const k = key.toLowerCase();
  return SECRET_KEY_FRAGMENTS.some((frag) => k.includes(frag));
}

/** Recursively copy `value`, replacing any secret-keyed leaf/branch with
 *  `[REDACTED]`. Handles nested objects and arrays; leaves primitives as-is.
 *  Guards against cycles (a repeated object is emitted once, then `[Circular]`).*/
function redactValue(value: unknown, seen: WeakSet<object>): unknown {
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value as object)) return "[Circular]";
  seen.add(value as object);

  if (Array.isArray(value)) {
    return value.map((v) => redactValue(v, seen));
  }
  // Buffers / typed arrays: don't walk their numeric indices — just note size.
  if (value instanceof Uint8Array) return `<${value.byteLength} bytes>`;

  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = isSecretKey(k) ? REDACTED : redactValue(v, seen);
  }
  return out;
}

/** Redact a log-fields bag (top level is always an object). */
export function redactFields(fields: LogFields): LogFields {
  return redactValue(fields, new WeakSet()) as LogFields;
}
