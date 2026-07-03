import { Hono } from "hono";
import { html } from "hono/html";
import type { HtmlEscapedString } from "hono/utils/html";
import { readLogTail } from "../obs/log-reader.ts";
import { redactFields } from "../obs/redact.ts";
import type { LogLevel } from "../core/ports.ts";

// Log-viewer API + SSR (task #24, audit-log). Read-only adapter over the audit
// streams written by obs (app/state) and the raw MQTT recorder (report). It
// TAILS the newest dated .jsonl file(s) via the bounded reader (obs/log-reader),
// filters by minimum level + a text query, and renders either JSON (GET
// /api/logs, the programmatic contract) or SSR HTML rows (GET /ui/logs, an htmx
// fragment the viewer page polls). NO domain logic; no static file is ever
// served (records are read, parsed, redefensively-redacted, then re-rendered).
//
// Streams:
//   app    → <logDir>/app-*.jsonl      (always available)
//   state  → <logDir>/state-*.jsonl    (always available)
//   report → <mqttLogDir>/*.jsonl      (only when MQTT_LOG=1)

type Html = HtmlEscapedString | Promise<HtmlEscapedString>;

export type LogStream = "app" | "state" | "report";

export interface LogsAppDeps {
  /** Directory for the app + state streams (RuntimeLoggerConfig.logDir). */
  logDir: string;
  /** Directory for the raw report firehose (RuntimeLoggerConfig.mqttLogDir). */
  mqttLogDir: string;
  /** Whether the raw report stream exists (MQTT_LOG=1). Gates the `report` stream. */
  mqttLogEnabled: boolean;
}

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };
const LEVELS: readonly LogLevel[] = ["debug", "info", "warn", "error"];

// Bounded read cap: how many raw records to pull from disk before filtering.
// Still byte-bounded by the reader (256 KiB × 3 files); this only caps the
// post-parse working set so a wide filter still has candidates to narrow.
const READ_CAP = 2000;
const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 1000;

interface LogQuery {
  stream: LogStream;
  level: LogLevel;
  q: string;
  limit: number;
}

/** A normalized, display-ready view of a record (tolerates both the pino app/
 *  state shape `{time,level,msg,…}` and the raw recorder shape `{ts,…}`). */
interface LogView {
  time: number | null;
  level: LogLevel;
  event: string;
  msg: string;
  extra: Record<string, unknown>;
}

export function createLogsApp(deps: LogsAppDeps): Hono {
  const app = new Hono();
  const available = (): LogStream[] => (deps.mqttLogEnabled ? ["app", "state", "report"] : ["app", "state"]);

  const parseQuery = (get: (k: string) => string | undefined): LogQuery => {
    const streams = available();
    const rawStream = get("stream");
    const stream: LogStream = (streams as string[]).includes(rawStream ?? "") ? (rawStream as LogStream) : "app";
    const rawLevel = (get("level") ?? "debug").toLowerCase();
    const level: LogLevel = (LEVELS as readonly string[]).includes(rawLevel) ? (rawLevel as LogLevel) : "debug";
    const q = (get("q") ?? "").trim();
    const rawLimit = Number(get("limit"));
    const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(Math.floor(rawLimit), MAX_LIMIT) : DEFAULT_LIMIT;
    return { stream, level, q, limit };
  };

  // Read → redact (defense in depth) → level filter → text filter → limit.
  const query = (params: LogQuery): Array<Record<string, unknown>> => {
    const dir = params.stream === "report" ? deps.mqttLogDir : deps.logDir;
    const prefix = params.stream === "report" ? "" : params.stream;
    const raw = readLogTail({ dir, prefix, limit: READ_CAP });
    const minLevel = LEVEL_ORDER[params.level];
    const needle = params.q.toLowerCase();
    const out: Array<Record<string, unknown>> = [];
    for (const rec of raw) {
      const red = redactFields(rec) as Record<string, unknown>;
      if (LEVEL_ORDER[recordLevel(red)] < minLevel) continue;
      if (needle && !JSON.stringify(red).toLowerCase().includes(needle)) continue;
      out.push(red);
      if (out.length >= params.limit) break;
    }
    return out;
  };

  // GET /api/logs — the JSON contract. { stream, records, streams }.
  app.get("/api/logs", (c) => {
    const streams = available();
    const rawStream = c.req.query("stream");
    // An explicitly-requested-but-unavailable stream (e.g. report while MQTT_LOG
    // off) is a 404 so it stays HIDDEN, not silently redirected to `app`.
    if (rawStream && !(streams as string[]).includes(rawStream)) {
      return c.json({ error: "stream not available", streams }, 404);
    }
    const params = parseQuery((k) => c.req.query(k));
    return c.json({ stream: params.stream, records: query(params), streams });
  });

  // GET /logs — the full viewer page (nav + controls + polling table). The
  // first paint renders the current rows server-side (works without JS); htmx's
  // `load` trigger then keeps #logrows fresh.
  app.get("/logs", (c) => {
    const params = parseQuery((k) => c.req.query(k));
    return c.html(renderLogsPage(available(), params, query(params).map(toView)));
  });

  // GET /ui/logs — the htmx fragment: just the rows table for the current query.
  app.get("/ui/logs", (c) => {
    const params = parseQuery((k) => c.req.query(k));
    return c.html(renderRows(query(params).map(toView)));
  });

  return app;
}

/** Effective level of a record: pino app/state carry a string `level`; raw
 *  report records have none → treated as "info". */
function recordLevel(rec: Record<string, unknown>): LogLevel {
  const l = typeof rec.level === "string" ? rec.level.toLowerCase() : "";
  return (LEVELS as readonly string[]).includes(l) ? (l as LogLevel) : "info";
}

const VIEW_OWN_KEYS = new Set(["time", "ts", "level", "msg", "event", "v"]);

function toView(rec: Record<string, unknown>): LogView {
  const time =
    typeof rec.time === "number" ? rec.time : typeof rec.ts === "number" ? rec.ts : null;
  const level = recordLevel(rec);
  const msg = typeof rec.msg === "string" ? rec.msg : "";
  const event = typeof rec.event === "string" ? rec.event : "";
  const extra: Record<string, unknown> = {};
  for (const [k, val] of Object.entries(rec)) {
    if (!VIEW_OWN_KEYS.has(k)) extra[k] = val;
  }
  return { time, level, event, msg, extra };
}

// ── rendering ─────────────────────────────────────────────────────────────────

const STREAM_LABEL: Record<LogStream, string> = {
  app: "アプリ",
  state: "状態遷移",
  report: "生レポート",
};

/** "07-03 08:00:00.123" (UTC) from an epoch-ms; "—" when absent. */
function fmtTime(ms: number | null): string {
  if (ms == null || !Number.isFinite(ms)) return "—";
  const iso = new Date(ms).toISOString(); // YYYY-MM-DDTHH:MM:SS.sssZ
  return iso.slice(5, 10) + " " + iso.slice(11, 23);
}

function renderRows(views: LogView[]): Html {
  if (views.length === 0) {
    return html`<div class="log-empty" data-log-empty>ログがありません</div>`;
  }
  const rows = views.map((v) => {
    const hasExtra = Object.keys(v.extra).length > 0;
    const extraJson = hasExtra ? JSON.stringify(v.extra, null, 2) : "";
    return html`
      <tr class="log-row lvl-${v.level}" data-log-row>
        <td class="log-time">${fmtTime(v.time)}</td>
        <td class="log-lvl"><span class="log-badge lvl-${v.level}">${v.level.toUpperCase()}</span></td>
        <td class="log-event">${v.event}</td>
        <td class="log-msg">
          <span class="log-msg-text">${v.msg}</span>
          ${hasExtra
            ? html`<details class="log-extra"><summary>詳細</summary><pre>${extraJson}</pre></details>`
            : ""}
        </td>
      </tr>
    `;
  });
  return html`
    <table class="log-table">
      <thead>
        <tr><th>時刻 (UTC)</th><th>レベル</th><th>イベント</th><th>内容</th></tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  `;
}

function renderControls(streams: LogStream[], q: LogQuery): Html {
  const streamTabs = streams.map(
    (s) => html`<option value="${s}" ${s === q.stream ? "selected" : ""}>${STREAM_LABEL[s]}</option>`,
  );
  const levelOpts = LEVELS.map(
    (l) => html`<option value="${l}" ${l === q.level ? "selected" : ""}>${l.toUpperCase()}</option>`,
  );
  const limitOpts = [50, 100, 200, 500, 1000].map(
    (n) => html`<option value="${n}" ${n === q.limit ? "selected" : ""}>${n}</option>`,
  );
  return html`
    <form id="logControls" class="log-controls">
      <label>ストリーム
        <select name="stream">${streamTabs}</select>
      </label>
      <label>レベル
        <select name="level">${levelOpts}</select>
      </label>
      <label class="log-search">検索
        <input type="search" name="q" value="${q.q}" placeholder="メッセージ・フィールド" autocomplete="off" />
      </label>
      <label>件数
        <select name="limit">${limitOpts}</select>
      </label>
      <button type="button" id="logRefresh" class="act">更新</button>
      <span class="muted log-auto">自動更新 5秒</span>
    </form>
  `;
}

/** Top navigation (self-contained copy — mirrors ui-routes/verify-routes nav,
 *  with ログ active here). Kept local so this adapter doesn't reach into ui. */
function nav(): Html {
  return html`<nav class="nav">
    <a class="navlink" href="/">キュー</a>
    <a class="navlink" href="/projects">プロジェクト</a>
    <a class="navlink" href="/verify">実機検証</a>
    <a class="navlink active" href="/logs">ログ</a>
  </nav>`;
}

function renderLogsPage(streams: LogStream[], q: LogQuery, initial: LogView[]): Html {
  // The rows container polls every 5s and re-fetches on any control change /
  // manual 更新. hx-include pulls the current control values into the request;
  // hx-trigger keeps it bounded (no wall-clock loop of our own). Newest-first is
  // guaranteed by the reader.
  const trigger =
    "load, change from:#logControls, keyup changed delay:300ms from:#logControls, click from:#logRefresh, every 5s";
  return html`<!doctype html>
<html lang="ja">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>ログ — Auto-swap</title>
  <script src="/vendor/htmx.min.js" defer></script>
  <link rel="stylesheet" href="/vendor/app.css" />
</head>
<body>
  <header class="topbar">
    <h1>ログ</h1>
    ${nav()}
    <span id="connChip" class="conn-chip" hidden>接続が切れました。表示が古い可能性があります</span>
  </header>
  <main class="log-main">
    ${renderControls(streams, q)}
    <div
      id="logrows"
      class="log-rows"
      hx-get="/ui/logs"
      hx-include="#logControls"
      hx-trigger="${trigger}"
      hx-swap="innerHTML"
    >${renderRows(initial)}</div>
  </main>
</body>
</html>`;
}
