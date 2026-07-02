# Logging & the log viewer (task #24)

Self-hosted, structured audit logging for the orchestrator. Three streams, all
daily-rotating JSONL under `data/` (gitignored), plus a read-only web viewer.

## Streams

| Stream   | File                              | Volume | When        | What                                                                 |
| -------- | --------------------------------- | ------ | ----------- | ------------------------------------------------------------------- |
| `app`    | `data/logs/app-YYYY-MM-DD.jsonl`  | low    | always on   | The structured app log (module loggers), filtered by `LOG_LEVEL`.   |
| `state`  | `data/logs/state-YYYY-MM-DD.jsonl`| low    | always on   | One line per *meaningful* printer state change (the fault trail).    |
| `report` | `data/mqtt-log/YYYY-MM-DD.jsonl`  | high   | `MQTT_LOG=1`| The verbatim raw MQTT push_status firehose (protocol debugging).     |

All three are driven off the **single** MQTT connection's `report` event — no
extra printer connections. `StateLog` (state stream) and `ReportRecorder` (report
stream) are wired in `src/main.ts`; `StateLog` always starts, `ReportRecorder`
only when `MQTT_LOG=1`. A boot record (`event: "boot"`) is written to `app` on
startup so `data/logs/` is populated from the first second (the file is created
lazily on the first write — an otherwise-quiet idle boot would look empty).

### Redaction

Every record passes through `obs/redact.ts` (key-name redaction: `accessCode`,
`token`, `webhook`, …) before it reaches disk, and the viewer redacts again on
read (defense in depth). Raw printer `report` payloads carry no secrets — the
access code lives in the MQTT *connection*, not the payload.

## Config (env)

| Var                 | Default          | Meaning                                   |
| ------------------- | ---------------- | ----------------------------------------- |
| `LOG_LEVEL`         | `info`           | Min level for the `app` stream.           |
| `LOG_FORMAT`        | `pretty` / `json`| Console format (json in `NODE_ENV=production`). |
| `LOG_DIR`           | `./data/logs`    | app + state stream directory.             |
| `MQTT_LOG_DIR`      | `./data/mqtt-log`| raw report stream directory.              |
| `MQTT_LOG`          | off              | `1` enables the raw report firehose.      |
| `LOG_RETENTION_DAYS`| `14`             | Rotated files older than this are pruned. |

## The viewer

- **Page:** `GET /logs` — reachable from every page's nav (「ログ」). SSR (Hono
  `html`) + vendored htmx, no CDN. Stream tabs, level filter, text search, limit,
  a manual 更新 button, and 5-second htmx polling. Newest-first, level-colour-coded
  rows, expandable per-record JSON.
- **JSON API:** `GET /api/logs?stream=app|state|report&level=<min>&q=<text>&limit=<n>`
  → `{ stream, records, streams }`. `records` are the parsed lines, newest-first,
  redacted. `report` is offered only when `MQTT_LOG=1` (else a 404 keeps it hidden).
- **htmx fragment:** `GET /ui/logs?…` — the rows table only (what the page polls).
- Behind `AUTH_TOKEN` with every other route when auth is enabled. Raw log files
  are **never** served as static assets — they are read, parsed and re-rendered.

### Bounded reader

`src/obs/log-reader.ts` tails only the last ~256 KiB of the newest dated file
(spilling into the previous day only to reach the requested count), so a huge
stream never loads whole into memory. Missing/empty dir → `[]`; a malformed or
half-written trailing line is tolerated, never thrown.
