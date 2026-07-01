import { Hono } from "hono";
import { html, raw } from "hono/html";
import type { HtmlEscapedString } from "hono/utils/html";
import type { Repo } from "../db/repo.ts";
import type { JobRow, JobStatus, PendingActionRow, Severity, StockerRow } from "../db/types.ts";

// `html` yields a Promise when any interpolation (e.g. an array of fragments) is
// async, so fragment helpers return the union rather than the bare string.
type Html = HtmlEscapedString | Promise<HtmlEscapedString>;

/**
 * Server-rendered Web UI (spec 17 / docs/ui-handoff.md). MVP slice #1: the
 * dashboard — queue list + status + stocker remaining + the 対応待ち banner.
 *
 * Presentation only: it reads the same Repo the JSON API does and renders HTML.
 * No domain logic here (that lives in core/). Built with Hono's `html` template
 * (auto-escapes interpolated values — filenames/messages come from uploads, so
 * escaping is a security boundary). No React, no build step (spec 17).
 *
 * Returned as a Hono app so it mounts alongside the JSON API and is testable via
 * `app.request("/")` with no server/port.
 */
export function createUiApp(repo: Repo): Hono {
  const app = new Hono();

  app.get("/", (c) => {
    const jobs = repo.listJobs();
    const stocker = repo.getStocker();
    const pending = repo.getUnresolvedPendingActions();
    return c.html(renderDashboard({ jobs, stocker, pending }));
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

function renderDashboard(data: {
  jobs: JobRow[];
  stocker: StockerRow | null;
  pending: PendingActionRow[];
}): Html {
  const { jobs, stocker, pending } = data;
  const cards =
    jobs.length === 0
      ? html`<li class="empty">キューは空です</li>`
      : html`${jobs.map(jobCard)}`;
  return html`<!doctype html>
<html lang="ja">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Auto-swap 印刷キュー</title>
  <style>${raw(STYLES)}</style>
</head>
<body>
  <header class="topbar">
    <h1>印刷キュー</h1>
    <div class="topbar-right">${stockerChip(stocker)}</div>
  </header>
  ${pendingBanner(pending)}
  <main>
    <ul class="queue">${cards}</ul>
  </main>
</body>
</html>`;
}

// Inline for this slice; moves to public/ when the SSE/htmx slice adds client JS.
const STYLES = `
  :root{--bg:#f6f7f9;--card:#fff;--ink:#1c2230;--muted:#6b7280;--line:#e5e7eb;
    --blue:#2563eb;--green:#16a34a;--red:#dc2626;--amber:#d97706;--slate:#475569;--grey:#9ca3af;}
  *{box-sizing:border-box}
  body{margin:0;font:15px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;background:var(--bg);color:var(--ink)}
  .topbar{display:flex;align-items:center;justify-content:space-between;padding:12px 18px;background:var(--card);border-bottom:1px solid var(--line)}
  .topbar h1{font-size:17px;margin:0}
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
