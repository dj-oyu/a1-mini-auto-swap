import { Hono } from "hono";
import { serveStatic } from "hono/bun";
import { html, raw } from "hono/html";
import type { HtmlEscapedString } from "hono/utils/html";
import type { Repo } from "../db/repo.ts";
import type { JobRow, JobStatus, PendingActionRow, Severity, StockerRow } from "../db/types.ts";

// `html` yields a Promise when any interpolation (e.g. an array of fragments) is
// async, so fragment helpers return the union rather than the bare string.
type Html = HtmlEscapedString | Promise<HtmlEscapedString>;

/**
 * Server-rendered Web UI (spec 17 / docs/ui-handoff.md).
 *   MVP #1: the dashboard — queue list + status + stocker + 対応待ち banner.
 *   MVP #2: htmx resolve/refill actions on the banner (this slice).
 *
 * Presentation only: it reads the same Repo the JSON API does and renders HTML.
 * No domain logic here (that lives in core/). Built with Hono's `html` template
 * (auto-escapes interpolated values — filenames/messages come from uploads, so
 * escaping is a security boundary). No React, no build step (spec 17); htmx is
 * vendored under public/ (self-hosted, no CDN).
 *
 * Returned as a Hono app so it mounts alongside the JSON API and is testable via
 * `app.request("/")` with no server/port.
 */
export function createUiApp(repo: Repo): Hono {
  const app = new Hono();

  const snapshot = () => ({
    jobs: repo.listJobs(),
    stocker: repo.getStocker(),
    pending: repo.getUnresolvedPendingActions(),
  });

  // Static assets (vendored htmx, later CSS/JS). Root is resolved from the
  // process CWD (repo root) — Bun-only, same runtime as main.ts/the harness.
  app.use("/vendor/*", serveStatic({ root: "./public" }));

  app.get("/", (c) => c.html(renderDashboard(snapshot())));

  // GET /ui/dashboard — the reactive #dashboard fragment on its own, so the SSE
  // client (and htmx) can re-fetch it on any event without a full page reload.
  app.get("/ui/dashboard", (c) => c.html(renderDashboardInner(snapshot())));

  // ── htmx action routes (MVP #2) ─────────────────────────────────────────────
  // These return the re-rendered #dashboard fragment so htmx can swap it in
  // place. They are thin adapters over the Repo — the same mutations the JSON
  // write routes expose (spec ch8); kept here so the swap payload is HTML.

  // POST /ui/pending-actions/:id/resolve — human clears an item from 対応待ち.
  app.post("/ui/pending-actions/:id/resolve", (c) => {
    const id = Number(c.req.param("id"));
    if (Number.isInteger(id) && id > 0) repo.resolvePendingAction(id);
    return c.html(renderDashboardInner(snapshot()));
  });

  // POST /ui/stocker/refill — human reports the stocker refilled; also clears
  // any outstanding stocker_refill pending (mirrors createWriteApp, INV-STOCKER-04).
  app.post("/ui/stocker/refill", (c) => {
    if (repo.getStocker()) {
      repo.refillStocker();
      for (const a of repo.getUnresolvedPendingActions()) {
        if (a.type === "stocker_refill") repo.resolvePendingAction(a.id);
      }
    }
    return c.html(renderDashboardInner(snapshot()));
  });

  return app;
}

// ── domain → presentation maps ────────────────────────────────────────────────
// Calm, consistent palette (spec 17 §8): printing=blue, success=green,
// failed=red, waiting=amber, advisory/neutral=grey. Red is reserved for
// "stop, act now"; everything else stays quiet.

const STATUS_META: Record<JobStatus, { label: string; cls: string }> = {
  processing: { label: "確認待ち", cls: "amber" },
  queued: { label: "待機中", cls: "slate" },
  printing: { label: "印刷中", cls: "blue" },
  success: { label: "完了", cls: "green" },
  failed: { label: "失敗", cls: "red" },
  aborted: { label: "中止", cls: "grey" },
  waiting_for_refill: { label: "補充待ち", cls: "amber" },
};

const PENDING_LABEL: Record<PendingActionRow["type"], string> = {
  filament_confirm: "フィラメント確認",
  stocker_refill: "ストッカー補充",
  retry_decision: "リトライ判断",
  filament_runout: "フィラメント切れ",
  color_decision: "色の判断",
  mechanical_check: "メカ点検",
};

const SEVERITY_CLS: Record<Severity, string> = {
  blocking_queue: "red",
  blocking_job: "amber",
  advisory: "grey",
};

// ── formatting helpers ────────────────────────────────────────────────────────

/** e.g. 4500 → "1時間15分", 900 → "15分". null → "—". */
function fmtDuration(seconds: number | null): string {
  if (seconds == null || seconds <= 0) return "—";
  const h = Math.floor(seconds / 3600);
  const m = Math.round((seconds % 3600) / 60);
  if (h > 0) return `${h}時間${m}分`;
  return `${m}分`;
}

interface Filament {
  slot: number;
  color: string;
  type?: string;
}

/** Parse the jobs.filaments JSON defensively; never throw into the renderer. */
function parseFilaments(json: string | null): Filament[] {
  if (!json) return [];
  try {
    const v = JSON.parse(json) as unknown;
    if (!Array.isArray(v)) return [];
    return v.filter(
      (f): f is Filament =>
        !!f && typeof f === "object" && typeof (f as Filament).color === "string",
    );
  } catch {
    return [];
  }
}

/** A CSS hex color is safe to inline only if it matches #rgb/#rrggbb; anything
 *  else (it comes from an uploaded file) is dropped to avoid style injection. */
function safeHex(color: string): string | null {
  return /^#[0-9a-fA-F]{3}([0-9a-fA-F]{3})?$/.test(color) ? color : null;
}

// ── fragments ─────────────────────────────────────────────────────────────────

function swatches(filaments: Filament[]): Html {
  const dots = filaments.map((f) => {
    const hex = safeHex(f.color);
    const style = hex ? `background:${hex}` : "background:repeating-linear-gradient(45deg,#ccc,#ccc 3px,#eee 3px,#eee 6px)";
    return html`<span class="swatch" style="${style}" title="slot ${f.slot}"></span>`;
  });
  return html`<span class="swatches">${dots}</span>`;
}

function jobCard(job: JobRow): Html {
  const meta = STATUS_META[job.status];
  const filaments = parseFilaments(job.filaments);
  const substituted = job.substituted_color != null;
  return html`
    <li class="card status-${meta.cls}" data-job-id="${job.id}">
      <div class="card-main">
        <div class="card-title">
          <span class="badge ${meta.cls}">${meta.label}</span>
          <span class="filename">${job.filename}</span>
        </div>
        <div class="card-sub">
          ${swatches(filaments)}
          <span class="eta">予定 ${fmtDuration(job.estimated_seconds)}</span>
          ${job.attempts > 0 ? html`<span class="attempts">試行 ${job.attempts}</span>` : ""}
          ${substituted
            ? html`<span class="subst" title="自動で色が代替されました">⚠ 色代替</span>`
            : ""}
        </div>
      </div>
    </li>
  `;
}

/** The action button on a 対応待ち row. stocker_refill resolves by refilling
 *  (clearing the empty state); everything else is a plain "解決". Both post to a
 *  /ui/* fragment route and let htmx swap the whole #dashboard in place. */
function resolveButton(a: PendingActionRow): Html {
  if (a.type === "stocker_refill") {
    return html`<button class="act" hx-post="/ui/stocker/refill" hx-target="#dashboard" hx-swap="outerHTML">補充完了</button>`;
  }
  return html`<button class="act" hx-post="/ui/pending-actions/${a.id}/resolve" hx-target="#dashboard" hx-swap="outerHTML">解決</button>`;
}

function pendingBanner(pending: PendingActionRow[]): Html {
  const count = pending.length;
  const hasBlockingQueue = pending.some((a) => a.severity === "blocking_queue");
  const tone = count === 0 ? "calm" : hasBlockingQueue ? "red" : "amber";
  if (count === 0) {
    return html`<section class="banner calm"><span class="banner-count">対応待ち 0</span><span class="banner-msg">すべて順調です</span></section>`;
  }
  const items = pending.map(
    (a) => html`
      <li class="pending ${SEVERITY_CLS[a.severity]}">
        <span class="ptype">${PENDING_LABEL[a.type]}</span>
        ${a.message ? html`<span class="pmsg">${a.message}</span>` : ""}
        ${a.job_id != null ? html`<span class="plink">#${a.job_id}</span>` : ""}
        ${resolveButton(a)}
      </li>
    `,
  );
  return html`
    <section class="banner ${tone}">
      <div class="banner-head"><span class="banner-count">対応待ち ${count}</span></div>
      <ul class="pending-list">${items}</ul>
    </section>
  `;
}

function stockerChip(stocker: StockerRow | null): Html {
  if (!stocker) return html`<span class="chip warn">ストッカー未設定</span>`;
  const low = stocker.remaining === 0 ? "red" : stocker.remaining <= 1 ? "amber" : "ok";
  return html`<span class="chip ${low}">プレート ${stocker.remaining}/${stocker.capacity}</span>`;
}

/** SQLite stores datetime('now') as "YYYY-MM-DD HH:MM:SS" in UTC (no tz). Turn
 *  it into an epoch-ms number for the client; NaN if unparseable. */
function sqliteUtcToEpoch(ts: string): number {
  return Date.parse(ts.replace(" ", "T") + "Z");
}

/** Live header for the currently-printing plate (spec 17 §7 / MVP #4). The
 *  server emits the start epoch + estimate as data-* attributes; the client
 *  (LIVE_SCRIPT) computes the % and the "終わる時刻" and ticks them between SSE
 *  events. Deterministic server-side: derived purely from the row, no clock.
 *  Progress is estimate-based until MQTT live remaining is plumbed in. */
function printingHeader(jobs: JobRow[]): Html {
  const job = jobs.find((j) => j.status === "printing");
  if (!job) return html``;
  const startMs = sqliteUtcToEpoch(job.updated_at);
  const est = job.estimated_seconds ?? 0;
  const startAttr = Number.isFinite(startMs) ? String(startMs) : "";
  return html`
    <section class="printing" data-printing data-start="${startAttr}" data-est="${est}">
      <div class="printing-head">
        <span class="badge blue">印刷中</span>
        <span class="filename">${job.filename}</span>
        <span class="eta-clock" data-eta>ETA —</span>
      </div>
      <div class="progressbar"><div class="prog-bar" style="width:0%"></div></div>
      <div class="printing-sub"><span class="pct">—</span></div>
    </section>
  `;
}

interface DashboardData {
  jobs: JobRow[];
  stocker: StockerRow | null;
  pending: PendingActionRow[];
}

/** The reactive part of the page: everything that changes when a 対応待ち item
 *  is resolved. Wrapped in #dashboard so htmx can swap it as one unit. */
function renderDashboardInner(data: DashboardData): Html {
  const { jobs, stocker, pending } = data;
  const cards =
    jobs.length === 0
      ? html`<li class="empty">キューは空です</li>`
      : html`${jobs.map(jobCard)}`;
  return html`<div id="dashboard">
    <div class="statusline">${stockerChip(stocker)}</div>
    ${printingHeader(jobs)}
    ${pendingBanner(pending)}
    <main><ul class="queue">${cards}</ul></main>
  </div>`;
}

function renderDashboard(data: DashboardData): Html {
  return html`<!doctype html>
<html lang="ja">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Auto-swap 印刷キュー</title>
  <script src="/vendor/htmx.min.js" defer></script>
  <style>${raw(STYLES)}</style>
</head>
<body>
  <header class="topbar"><h1>印刷キュー</h1></header>
  ${renderDashboardInner(data)}
  <script>${raw(LIVE_SCRIPT)}</script>
</body>
</html>`;
}

// Live updates (spec 17 §3): subscribe to the SSE stream and, on any event,
// re-fetch just the #dashboard fragment via htmx. Named events (see
// sse-notifier formatFrame) need addEventListener, not onmessage. Inline for
// now; moves to public/ alongside the CSS in a later slice.
const LIVE_SCRIPT = `
  (function () {
    // MVP #4: tick the printing header's % and finish-time locally between
    // events (progress is estimate-based until MQTT live remaining lands).
    function fmtClock(epoch) {
      try { return new Date(epoch).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); }
      catch (e) { return '--:--'; }
    }
    function updatePrinting() {
      var els = document.querySelectorAll('[data-printing]');
      for (var i = 0; i < els.length; i++) {
        var el = els[i];
        var start = Number(el.getAttribute('data-start'));
        var est = Number(el.getAttribute('data-est'));
        var bar = el.querySelector('.prog-bar');
        var pctEl = el.querySelector('.pct');
        var etaEl = el.querySelector('[data-eta]');
        if (!start || !est) { if (pctEl) pctEl.textContent = '進行中'; continue; }
        var pct = Math.max(0, Math.min(100, (Date.now() - start) / 1000 / est * 100));
        if (bar) bar.style.width = pct.toFixed(1) + '%';
        if (pctEl) pctEl.textContent = Math.floor(pct) + '%';
        if (etaEl) etaEl.textContent = 'ETA ' + fmtClock(start + est * 1000);
      }
    }

    updatePrinting();
    setInterval(updatePrinting, 30000);
    document.body.addEventListener('htmx:afterSwap', updatePrinting);

    if (!window.EventSource) return;
    var refresh = function () {
      if (window.htmx) window.htmx.ajax('GET', '/ui/dashboard', { target: '#dashboard', swap: 'outerHTML' });
    };
    var es = new EventSource('/events');
    ['job_started','job_finished','job_failed','waiting_for_refill','pending_action','filament_switched','timeout']
      .forEach(function (t) { es.addEventListener(t, refresh); });
  })();
`;

// Inline for this slice; moves to public/ when the SSE/htmx slice adds client JS.
const STYLES = `
  :root{--bg:#f6f7f9;--card:#fff;--ink:#1c2230;--muted:#6b7280;--line:#e5e7eb;
    --blue:#2563eb;--green:#16a34a;--red:#dc2626;--amber:#d97706;--slate:#475569;--grey:#9ca3af;}
  *{box-sizing:border-box}
  body{margin:0;font:15px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;background:var(--bg);color:var(--ink)}
  .topbar{display:flex;align-items:center;justify-content:space-between;padding:12px 18px;background:var(--card);border-bottom:1px solid var(--line)}
  .topbar h1{font-size:17px;margin:0}
  .statusline{display:flex;justify-content:flex-end;padding:12px 18px 0}
  .printing{margin:12px 18px;padding:14px 16px;background:var(--card);border:1px solid var(--line);border-left:4px solid var(--blue);border-radius:12px}
  .printing-head{display:flex;gap:10px;align-items:center}
  .printing-head .filename{font-weight:600;overflow-wrap:anywhere}
  .printing-head .eta-clock{margin-left:auto;color:var(--blue);font-weight:600;font-variant-numeric:tabular-nums;white-space:nowrap}
  .progressbar{height:8px;background:#eef2f7;border-radius:999px;overflow:hidden;margin:10px 0 6px}
  .prog-bar{height:100%;background:var(--blue);border-radius:999px;transition:width .4s ease}
  .printing-sub{color:var(--muted);font-size:13px;font-variant-numeric:tabular-nums}
  .chip{font-size:13px;padding:4px 10px;border-radius:999px;background:#eef2f7;color:var(--ink)}
  .chip.ok{background:#e8f5ee;color:var(--green)} .chip.amber{background:#fdf0e2;color:var(--amber)} .chip.red{background:#fdeaea;color:var(--red)} .chip.warn{background:#fdf0e2;color:var(--amber)}
  .banner{margin:14px 18px;padding:12px 14px;border-radius:12px;border:1px solid var(--line);background:var(--card)}
  .banner.calm{display:flex;gap:10px;align-items:center;color:var(--green);background:#f1f9f4;border-color:#cdebd8}
  .banner.amber{background:#fdf6ec;border-color:#f2dcbb}
  .banner.red{background:#fdecec;border-color:#f4c9c9}
  .banner-count{font-weight:700}
  .banner-msg{color:var(--muted)}
  .pending-list{list-style:none;margin:8px 0 0;padding:0;display:flex;flex-direction:column;gap:6px}
  .pending{display:flex;gap:10px;align-items:center;padding:6px 10px;border-radius:8px;background:#fff}
  .pending .ptype{font-weight:600}
  .pending.red .ptype{color:var(--red)} .pending.amber .ptype{color:var(--amber)} .pending.grey .ptype{color:var(--muted)}
  .pending .pmsg{color:var(--muted);font-size:14px}
  .pending .plink{margin-left:auto;color:var(--muted);font-variant-numeric:tabular-nums}
  .pending .act{margin-left:auto}
  .pending .plink + .act{margin-left:0}
  .act{font:inherit;font-size:13px;padding:5px 12px;border:1px solid var(--line);border-radius:8px;background:#fff;color:var(--ink);cursor:pointer}
  .act:hover{background:#f3f4f6}
  .pending.red .act{border-color:var(--red);color:var(--red)}
  .pending .act[hx-post*="stocker"]{border-color:var(--amber);color:var(--amber)}
  main{padding:0 18px 24px}
  .queue{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:10px}
  .empty{color:var(--muted);padding:24px;text-align:center}
  .card{background:var(--card);border:1px solid var(--line);border-left:4px solid var(--grey);border-radius:10px;padding:12px 14px}
  .card.status-blue{border-left-color:var(--blue)} .card.status-green{border-left-color:var(--green)}
  .card.status-red{border-left-color:var(--red)} .card.status-amber{border-left-color:var(--amber)}
  .card.status-slate{border-left-color:var(--slate)} .card.status-grey{border-left-color:var(--grey)}
  .card-title{display:flex;gap:10px;align-items:center}
  .filename{font-weight:600;overflow-wrap:anywhere}
  .badge{font-size:12px;font-weight:700;padding:3px 8px;border-radius:6px;color:#fff;white-space:nowrap}
  .badge.blue{background:var(--blue)} .badge.green{background:var(--green)} .badge.red{background:var(--red)}
  .badge.amber{background:var(--amber)} .badge.slate{background:var(--slate)} .badge.grey{background:var(--grey)}
  .card-sub{display:flex;gap:14px;align-items:center;margin-top:8px;color:var(--muted);font-size:13px;flex-wrap:wrap}
  .swatches{display:inline-flex;gap:4px}
  .swatch{width:14px;height:14px;border-radius:50%;border:1px solid rgba(0,0,0,.15);display:inline-block}
  .subst{color:var(--amber);font-weight:600}
`;
