import { Hono } from "hono";
import { serveStatic } from "hono/bun";
import { html, raw } from "hono/html";
import type { HtmlEscapedString } from "hono/utils/html";
import { projectRemainingSec } from "../core/eta.ts";
import type { Repo } from "../db/repo.ts";

// Re-exported for existing consumers/tests; the ETA aggregation rule itself
// lives in core (spec 10) — presentation only renders it.
export { projectRemainingSec };
import type {
  ColorConsistencyPolicy,
  JobRow,
  JobStatus,
  PendingActionRow,
  ProjectRow,
  Severity,
  StockerRow,
} from "../db/types.ts";

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

  // GET /projects — the projects page (spec 17: policy + 所属プレート progress).
  app.get("/projects", (c) => c.html(renderProjectsPage(repo)));
  app.get("/ui/projects", (c) => c.html(renderProjectsInner(repo)));

  // POST /ui/projects — create a project; returns the refreshed #projects fragment.
  app.post("/ui/projects", async (c) => {
    const body = await c.req.parseBody();
    const name = typeof body.name === "string" ? body.name.trim() : "";
    const policy = isPolicy(body.policy) ? body.policy : "strict";
    if (name) repo.createProject(name, policy);
    return c.html(renderProjectsInner(repo));
  });

  // POST /ui/projects/:id/policy — toggle color-consistency policy (htmx).
  app.post("/ui/projects/:id/policy", async (c) => {
    const id = Number(c.req.param("id"));
    const body = await c.req.parseBody();
    if (Number.isInteger(id) && id > 0 && repo.getProject(id) && isPolicy(body.policy)) {
      repo.setProjectPolicy(id, body.policy);
    }
    return c.html(renderProjectsInner(repo));
  });

  // GET /ui/queue/:id/confirm — the filament-confirm modal for a processing job
  // (spec 17 §6). Loaded into #modal by htmx; submits via PATCH (client-side).
  app.get("/ui/queue/:id/confirm", (c) => {
    const id = Number(c.req.param("id"));
    const job = Number.isInteger(id) && id > 0 ? repo.getJob(id) : null;
    return c.html(renderConfirmPanel(job, repo.listProjects()));
  });

  // GET /ui/snapshot — the camera modal (spec 17 §5). The <img> points at the
  // snapshot API; 更新 re-fetches with a cache-buster (see app.js).
  app.get("/ui/snapshot", (c) => c.html(renderSnapshotPanel()));

  // GET /ui/queue/:id/preview — a read-only 3D preview modal (any job), opened
  // by clicking a card's thumbnail (spec 17 §9).
  app.get("/ui/queue/:id/preview", (c) => {
    const id = Number(c.req.param("id"));
    const job = Number.isInteger(id) && id > 0 ? repo.getJob(id) : null;
    return c.html(renderPreviewPanel(job));
  });

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

/** Parse the jobs.filaments JSON defensively and normalize the slot number.
 *  Uploads store the extractor's shape ({index,color,type}, 0-based); the seed
 *  uses {slot,...} (1-based). Normalize both to a 1-based `slot` (falling back to
 *  array position) so the confirm mapping lines up with AMS trays. Never throws. */
function parseFilaments(json: string | null): Filament[] {
  if (!json) return [];
  try {
    const v = JSON.parse(json) as unknown;
    if (!Array.isArray(v)) return [];
    const out: Filament[] = [];
    v.forEach((raw, i) => {
      if (!raw || typeof raw !== "object") return;
      const f = raw as { slot?: unknown; index?: unknown; color?: unknown; type?: unknown };
      if (typeof f.color !== "string") return;
      const slot = Number.isInteger(f.slot)
        ? (f.slot as number)
        : Number.isInteger(f.index)
          ? (f.index as number) + 1
          : i + 1;
      out.push({ slot, color: f.color, type: typeof f.type === "string" ? f.type : undefined });
    });
    return out;
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
      <img class="card-thumb" src="/api/queue/${job.id}/thumbnail" alt="3Dプレビューを開く" title="3Dプレビュー" loading="lazy" data-onerror="remove" hx-get="/ui/queue/${job.id}/preview" hx-target="#modal" hx-swap="innerHTML" />
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
          ${job.status === "processing"
            ? html`<button class="act primary card-confirm" hx-get="/ui/queue/${job.id}/confirm" hx-target="#modal" hx-swap="innerHTML">フィラメント確認</button>`
            : ""}
        </div>
        ${cardActions(job)}
      </div>
    </li>
  `;
}

/** Statuses whose dispatch order can still be changed by reordering. */
const REORDERABLE: JobStatus[] = ["queued", "processing", "waiting_for_refill"];

/** Per-card management actions (spec 17): reorder (↑/↓) the upcoming plates,
 *  retry a failed job, abort the running one, delete any non-printing job.
 *  All are client fetch + #dashboard refresh (see LIVE_SCRIPT). Abort/delete
 *  are two-step ("本当に…？") — no native dialog. */
function cardActions(job: JobRow): Html {
  const buttons: Html[] = [];
  if (REORDERABLE.includes(job.status)) {
    buttons.push(html`<span class="drag-handle act move" data-drag-handle title="ドラッグで並び替え" aria-hidden="true">⠿</span>`);
    buttons.push(html`<button class="act move" data-move-up="${job.id}" title="上へ" aria-label="上へ">↑</button>`);
    buttons.push(html`<button class="act move" data-move-down="${job.id}" title="下へ" aria-label="下へ">↓</button>`);
  }
  if (job.status === "printing") {
    buttons.push(html`<button class="act danger" data-abort="${job.id}">中止</button>`);
  }
  if (job.status === "failed") {
    buttons.push(html`<button class="act" data-retry="${job.id}">リトライ</button>`);
  }
  if (job.status !== "printing") {
    buttons.push(html`<button class="act danger" data-delete="${job.id}">削除</button>`);
  }
  if (buttons.length === 0) return html``;
  return html`<div class="card-actions">${buttons}</div>`;
}

/** Common accessibility attributes for every .modal-box (a11y polish slice):
 *  an ARIA dialog role so assistive tech announces it as a modal, plus a
 *  tabindex so app.js can focus the box itself when it has no focusable
 *  children. Kept as one constant so all six modal-box call sites stay in sync. */
const MODAL_BOX_A11Y = raw(' role="dialog" aria-modal="true" tabindex="-1"');

/** Camera snapshot modal (spec 17 §5). The img 404s gracefully to a message
 *  when no frame is available (via app.js's delegated error handler,
 *  data-onerror="snapshot"); 更新 reloads it with a cache-buster. */
function renderSnapshotPanel(): Html {
  return html`
    <div class="modal-overlay" data-close>
      <div class="modal-box"${MODAL_BOX_A11Y}>
        <h2 class="modal-title">カメラ</h2>
        <img
          class="snapshot"
          src="/api/printer/snapshot"
          alt="printer camera"
          data-onerror="snapshot"
        />
        <p class="muted snapshot-none" hidden>スナップショットがありません</p>
        <div class="modal-actions">
          <button class="act" data-snap-refresh>更新</button>
          <button class="act" data-close>閉じる</button>
        </div>
      </div>
    </div>
  `;
}

/** Read-only 3D preview modal for any job (spec 17 §9). */
function renderPreviewPanel(job: JobRow | null): Html {
  if (!job) {
    return html`<div class="modal-overlay" data-close><div class="modal-box"${MODAL_BOX_A11Y}>ジョブが見つかりません。<div class="modal-actions"><button class="act" data-close>閉じる</button></div></div></div>`;
  }
  const filaments = parseFilaments(job.filaments);
  return html`
    <div class="modal-overlay" data-close>
      <div class="modal-box"${MODAL_BOX_A11Y}>
        <h2 class="modal-title">3D プレビュー</h2>
        <p class="muted">${job.filename}</p>
        ${renderViewer(job.id, filaments[0]?.color)}
        <div class="modal-actions"><button class="act" data-close>閉じる</button></div>
      </div>
    </div>
  `;
}

/** Parse jobs.ams_mapping into a 4-element array of tray indices (-1 default). */
function parseMapping(json: string | null): number[] {
  const out = [-1, -1, -1, -1];
  if (!json) return out;
  try {
    const v = JSON.parse(json) as unknown;
    if (Array.isArray(v)) {
      for (let i = 0; i < 4; i++) {
        if (Number.isInteger(v[i])) out[i] = v[i] as number;
      }
    }
  } catch {
    /* keep defaults */
  }
  return out;
}

/** A 3D preview container (spec 17 §9). viewer.js loads /model into a Three.js
 *  canvas here; until then / on failure the fallback thumbnail <img> shows. */
function renderViewer(jobId: number, colorHex?: string): Html {
  const color = colorHex && safeHex(colorHex) ? colorHex : "#4b9fea";
  return html`
    <div class="viewer" data-model-url="/api/queue/${jobId}/model" data-color="${color}">
      <img class="viewer-fallback" src="/api/queue/${jobId}/thumbnail" alt="" data-onerror="remove" />
    </div>
  `;
}

function swatchDot(color: string): Html {
  const hex = safeHex(color);
  const style = hex
    ? `background:${hex}`
    : "background:repeating-linear-gradient(45deg,#ccc,#ccc 3px,#eee 3px,#eee 6px)";
  return html`<span class="swatch" style="${style}"></span>`;
}

/** The filament-confirm modal (spec 17 §6): per-slot color swatch + an AMS tray
 *  dropdown. Submitting PATCHes /api/queue/:id/filaments (client-side, see
 *  LIVE_SCRIPT) and moves the job processing→queued. The last line of defense
 *  against a wrong mapping, so it leans on color, not just text. */
function renderConfirmPanel(job: JobRow | null, projects: ProjectRow[] = []): Html {
  if (!job) {
    return html`<div class="modal-overlay" data-close><div class="modal-box"${MODAL_BOX_A11Y}>ジョブが見つかりません。<div class="modal-actions"><button class="act" data-close>閉じる</button></div></div></div>`;
  }
  if (job.status !== "processing") {
    return html`<div class="modal-overlay" data-close><div class="modal-box"${MODAL_BOX_A11Y}>このジョブは確認待ちではありません（${STATUS_META[job.status].label}）。<div class="modal-actions"><button class="act" data-close>閉じる</button></div></div></div>`;
  }
  const filaments = parseFilaments(job.filaments);
  const mapping = parseMapping(job.ams_mapping);
  const projectOpts = [
    html`<option value="" ${job.project_id == null ? "selected" : ""}>（プロジェクトなし）</option>`,
    ...projects.map(
      (p) => html`<option value="${p.id}" ${p.id === job.project_id ? "selected" : ""}>${p.name}</option>`,
    ),
  ];
  const rows =
    filaments.length === 0
      ? html`<p class="muted">検出されたフィラメントがありません。</p>`
      : filaments.map((f) => {
          const cur = mapping[f.slot - 1] ?? -1;
          const opts = [-1, 0, 1, 2, 3].map(
            (t) =>
              html`<option value="${t}" ${t === cur ? "selected" : ""}>${
                t === -1 ? "未使用" : `AMS ${t + 1}`
              }</option>`,
          );
          return html`
            <div class="fil-row" data-color="${f.color}">
              ${swatchDot(f.color)}
              <span class="fil-slot">スロット ${f.slot}</span>
              <select data-slot="${f.slot}">${opts}</select>
            </div>
          `;
        });
  return html`
    <div class="modal-overlay" data-close>
      <div class="modal-box"${MODAL_BOX_A11Y}>
        <h2 class="modal-title">フィラメント確認</h2>
        <p class="muted">${job.filename}</p>
        ${renderViewer(job.id, filaments[0]?.color)}
        <div class="fil-list">${rows}</div>
        <label class="proj-assign">プロジェクト
          <select data-project>${projectOpts}</select>
        </label>
        <div class="modal-actions">
          <button class="act" data-close>キャンセル</button>
          <button class="act primary" data-confirm="${job.id}">この内容で確定</button>
        </div>
      </div>
    </div>
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
    <section class="printing" data-printing data-job-id="${job.id}" data-start="${startAttr}" data-est="${est}">
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
    <div class="statusline">
      <button class="act cam" hx-get="/ui/snapshot" hx-target="#modal" hx-swap="innerHTML">📷 カメラ</button>
      ${stockerChip(stocker)}
    </div>
    ${printingHeader(jobs)}
    ${pendingBanner(pending)}
    <main><ul class="queue">${cards}</ul></main>
  </div>`;
}

// ── projects page ─────────────────────────────────────────────────────────────

function isPolicy(v: unknown): v is ColorConsistencyPolicy {
  return v === "strict" || v === "propagate";
}

const POLICY_LABEL: Record<ColorConsistencyPolicy, string> = {
  strict: "厳密（色を固定）",
  propagate: "伝播（代替色を継承）",
};

const ACTIVE_STATUSES: JobStatus[] = ["processing", "queued", "printing", "waiting_for_refill"];

/** Top navigation shared by the dashboard, projects and verify pages. */
function nav(active: "queue" | "projects" | "verify"): Html {
  const cls = (k: string) => (k === active ? "navlink active" : "navlink");
  return html`<nav class="nav">
    <a class="${cls("queue")}" href="/">キュー</a>
    <a class="${cls("projects")}" href="/projects">プロジェクト</a>
    <a class="${cls("verify")}" href="/verify">実機検証</a>
  </nav>`;
}

function projectCard(project: ProjectRow, jobs: JobRow[]): Html {
  const mine = jobs.filter((j) => j.project_id === project.id);
  const total = mine.length;
  const done = mine.filter((j) => j.status === "success").length;
  const active = mine.filter((j) => ACTIVE_STATUSES.includes(j.status));
  const etaSec = projectRemainingSec(active);
  const running = mine.find((j) => j.status === "printing");
  const substituted = mine.some((j) => j.substituted_color != null);
  const opt = (p: ColorConsistencyPolicy) =>
    html`<option value="${p}" ${p === project.color_consistency_policy ? "selected" : ""}>${POLICY_LABEL[p]}</option>`;
  return html`
    <li
      class="card proj-card"
      data-project-id="${project.id}"
      data-eta-sec="${etaSec}"
      data-run-id="${running ? String(running.id) : ""}"
      data-run-est="${running?.estimated_seconds ?? 0}"
    >
      <div class="card-main">
        <div class="card-title">
          <span class="filename">${project.name}</span>
          ${substituted ? html`<span class="subst" title="一部プレートで色が代替されました">⚠ 色代替</span>` : ""}
        </div>
        <div class="card-sub">
          <span>${total} プレート</span>
          <span>完了 ${done}/${total}</span>
          ${etaSec > 0 ? html`<span>残り予定 ${fmtDuration(etaSec)}</span>` : ""}
          ${etaSec > 0 ? html`<span class="proj-eta" data-eta>完了予定 —</span>` : ""}
        </div>
        <div class="card-sub">
          <label class="policy-label">色ポリシー
            <select name="policy" hx-post="/ui/projects/${project.id}/policy" hx-target="#projects" hx-swap="outerHTML">
              ${opt("strict")}${opt("propagate")}
            </select>
          </label>
        </div>
      </div>
    </li>
  `;
}

function renderProjectsInner(repo: Repo): Html {
  const projects = repo.listProjects();
  const jobs = repo.listJobs();
  const list =
    projects.length === 0
      ? html`<li class="empty">プロジェクトがありません</li>`
      : html`${projects.map((p) => projectCard(p, jobs))}`;
  return html`<div id="projects">
    <form class="proj-new" hx-post="/ui/projects" hx-target="#projects" hx-swap="outerHTML">
      <input name="name" placeholder="新しいプロジェクト名" required />
      <select name="policy">
        <option value="strict">厳密（色を固定）</option>
        <option value="propagate">伝播（代替色を継承）</option>
      </select>
      <button class="act primary" type="submit">作成</button>
    </form>
    <ul class="queue">${list}</ul>
  </div>`;
}

function renderProjectsPage(repo: Repo): Html {
  return html`<!doctype html>
<html lang="ja">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>プロジェクト — Auto-swap</title>
  <script src="/vendor/htmx.min.js" defer></script>
  <link rel="stylesheet" href="/vendor/app.css" />
</head>
<body>
  <header class="topbar">
    <h1>プロジェクト</h1>
    ${nav("projects")}
    <span id="connChip" class="conn-chip" hidden>接続が切れました。表示が古い可能性があります</span>
  </header>
  <main>${renderProjectsInner(repo)}</main>
  <script src="/vendor/shared.js" defer></script>
  <script src="/vendor/projects.js" defer></script>
</body>
</html>`;
}


function renderDashboard(data: DashboardData): Html {
  return html`<!doctype html>
<html lang="ja">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Auto-swap 印刷キュー</title>
  <script src="/vendor/htmx.min.js" defer></script>
  <script type="importmap">${raw('{"imports":{"three":"/vendor/three.module.min.js"}}')}</script>
  <script type="module" src="/vendor/viewer.js"></script>
  <link rel="stylesheet" href="/vendor/app.css" />
</head>
<body>
  <header class="topbar">
    <h1>印刷キュー</h1>
    ${nav("queue")}
    <span id="connChip" class="conn-chip" hidden>接続が切れました。表示が古い可能性があります</span>
    <span id="uploadChip" class="upload-chip" hidden></span>
    <div class="upload-wrap">
      <label class="upload" id="dropzone">
        <input type="file" accept=".gcode.3mf,.3mf" hidden id="fileInput" />
        <span>＋ 3MF をアップロード</span>
      </label>
      <span class="upload-status" id="uploadStatus"></span>
    </div>
  </header>
  ${renderDashboardInner(data)}
  <div id="modal"></div>
  <div id="toast" class="toast" hidden></div>
  <script src="/vendor/shared.js" defer></script>
  <script src="/vendor/app.js" defer></script>
</body>
</html>`;
}


