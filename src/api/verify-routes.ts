import { Hono } from "hono";
import { html, raw } from "hono/html";
import type { HtmlEscapedString } from "hono/utils/html";
import { z } from "zod";
import type { Repo } from "../db/repo.ts";
import type { DiagnosticsResult } from "../orchestrator/diagnostics.ts";
import type { PrinterStatusView } from "./printer-routes.ts";

/**
 * 実機検証ガイド (`/verify`) — a Stage 1-7 wizard for the first time a Windows
 * laptop drives a real A1 mini (real-hardware verification plan). Automatable
 * checks (TCP / MQTT / FTPS / orchestrator reachability, the dry-rehearsal run)
 * are judged from injected deps; physical confirmations are explicit checkboxes
 * / manual marks. Progress + findings persist in `system_settings.verify_progress`.
 *
 * Presentation only, like ui-routes.ts: it renders HTML and calls injected deps.
 * NO domain logic lives here — every real I/O (diagnostics probe, printer
 * status, dry-run publish, eject) is a dep the composition root wires, so the
 * routes are unit-testable with fakes and never touch hardware directly. Secrets
 * (access code) are never surfaced: the injected DiagnosticsResult already omits
 * them, and nothing here reads credentials.
 */

type Html = HtmlEscapedString | Promise<HtmlEscapedString>;

// ── injected boundary ─────────────────────────────────────────────────────────

export interface VerifyDeps {
  repo: Pick<Repo, "getSetting" | "setSetting">;
  /** Run the connectivity probe (Stage 1-3). */
  runDiagnostics: () => Promise<DiagnosticsResult>;
  /** Latest printer status view (Stage 4 + the dry-run busy guard). */
  printerStatus: () => PrinterStatusView | Promise<PrinterStatusView>;
  /** Publish the print-free dry-rehearsal job (Stage 5). `includeSwap` appends
   *  the real swap profile after the motion trajectory (dry-gcode.ts §9), so the
   *  rehearsal also exercises a real plate swap end-to-end. */
  startDryRun: (includeSwap: boolean) => Promise<void>;
  /** stop + eject job (Stage 6). */
  eject: () => Promise<void>;
  /** True when a real queue job is currently 'printing' — Stage 6's raw eject
   *  is refused then (審 2026-07-02: it bypasses the dispatcher and would
   *  desync/misattribute against a live queue print). */
  hasPrintingJob?: () => boolean;

  // ── TEMPORARY (実機検証用 — 確認後に削除, task#16) ──────────────────────────
  // swap直前スナップショット+Discord写真付き報告のフィールドテスト。全て任意:
  // 未配線ならUIセクションごと出ない(既存テスト/ハーネスは無変更で通る)。
  /** TEMPORARY: capture one camera frame right now (relay-backed). */
  testSnapshot?: () => Promise<Buffer | null>;
  /** TEMPORARY: send a photo-attached completion report to Discord. */
  sendPhotoReport?: (jpeg: Buffer, note: string) => Promise<boolean>;
  /** TEMPORARY: arm/disarm the auto capture on the next print. */
  armAutoCapture?: (armed: boolean) => void;
  /** TEMPORARY: current auto-capture state for display. */
  autoCaptureState?: () => TempAutoCaptureState;
}

/** TEMPORARY (実機検証用): auto-capture state surfaced in the wizard. */
export interface TempAutoCaptureState {
  armed: boolean;
  fired: { trigger: string; at: string; photoSent: boolean } | null;
}

// ── persisted progress (zod-validated round-trip) ─────────────────────────────

const SETTING_KEY = "verify_progress";

const StageStatus = z.enum(["pending", "passed", "failed"]);
type StageStatus = z.infer<typeof StageStatus>;

const StageState = z.object({ status: StageStatus, note: z.string() });

const DiagEvidence = z.object({
  ran_at: z.string(),
  mqtt_reachable: z.boolean(),
  ftps_reachable: z.boolean(),
  mqtt_auth_ok: z.boolean(),
  report_received: z.boolean(),
  ftps_auth_ok: z.boolean(),
  prot_mode: z.enum(["P", "C", "none"]),
  prot_detail: z.string().nullable(),
  /** Pretty-printed `print` block — evidence for protocol-notes. Never secrets. */
  sample_report: z.string().nullable(),
});

const StatusEvidence = z.object({
  ran_at: z.string(),
  gcode_state: z.string(),
  printing: z.boolean(),
});

const ProgressSchema = z.object({
  stages: z.record(z.string(), StageState),
  diagnostics: DiagEvidence.nullable(),
  printer: StatusEvidence.nullable(),
});
type Progress = z.infer<typeof ProgressSchema>;

interface StageDef {
  n: number;
  title: string;
  auto: boolean;
  desc: string;
  /** Informational "確認項目 (手動チェック)" reminders shown on the card. */
  manualChecks?: string[];
}

const STAGES: StageDef[] = [
  { n: 1, title: "TCP到達性", auto: true, desc: "8883 (MQTT) / 990 (FTPS) への TCP 接続を確認します。診断APIの mqtt_reachable / ftps_reachable で自動判定します。" },
  {
    n: 2,
    title: "MQTT受動観測",
    auto: true,
    desc: "MQTT 認証と report 受信を確認します。mqtt_auth_ok && report_received で自動判定します。受信した生 report をエビデンスとして下に表示します（protocol-notes 更新の材料）。",
    manualChecks: ["AMS は差分 push か、全量 push か（生 report を見て判断）"],
  },
  { n: 3, title: "FTPS接続", auto: true, desc: "implicit FTPS ログインを ftps_auth_ok で自動判定します。データチャネルの PROT モード（spec 19 の★実測項目）を目立つ位置に表示します。" },
  { n: 4, title: "オーケストレーター疎通", auto: true, desc: "GET /api/printer/status が実機の IDLE を返すかで自動判定します。" },
  {
    n: 5,
    title: "ドライリハーサル印刷",
    auto: false,
    desc: "加熱・押出なしのモーションテストを実行します。下の物理安全チェックを全て済ませるまで実行ボタンは押せません。実行後、SSE で gcode_state / 進捗をライブ表示し、FINISH で合格です。",
  },
  {
    n: 6,
    title: "stop→排出ジョブ",
    auto: false,
    desc: "Stage 5 の印刷中に中止ボタンを押すと、stop + 排出ジョブを送信します。",
    manualChecks: ["G28 でホームに正常復帰したか"],
  },
  { n: 7, title: "実印刷 1 枚", auto: false, desc: "手動工程です。通常 UI から 1 プレートだけ実印刷して仕上げてください。完了は手動でマークします。" },
];

/** The three physical safety confirmations that gate the Stage 5 run button. */
const SAFETY_CHECKS = ["ベッドは空である", "一時停止ボタンに手が届く", "可動域を目視確認した"];

/** The two extra physical confirmations required only for the "スワップ込み
 *  リハーサル" (includeSwap) variant — the real交換mod actually has to move. */
const SWAP_SAFETY_CHECKS = ["交換modが装着され動作可能", "ストッカーに供給用プレートがある"];

function initialProgress(): Progress {
  const stages: Record<string, z.infer<typeof StageState>> = {};
  for (const s of STAGES) stages[String(s.n)] = { status: "pending", note: "" };
  return { stages, diagnostics: null, printer: null };
}

/** Load persisted progress; ANY corruption (unparseable / wrong shape) falls
 *  back to a clean initial state rather than throwing (INV: never 500 the page). */
function loadProgress(repo: VerifyDeps["repo"]): Progress {
  const rawText = repo.getSetting(SETTING_KEY);
  if (!rawText) return initialProgress();
  let json: unknown;
  try {
    json = JSON.parse(rawText);
  } catch {
    return initialProgress();
  }
  const parsed = ProgressSchema.safeParse(json);
  if (!parsed.success) return initialProgress();
  // Merge over the initial map so any newly-added stage still has an entry.
  return { ...parsed.data, stages: { ...initialProgress().stages, ...parsed.data.stages } };
}

function saveProgress(repo: VerifyDeps["repo"], p: Progress): void {
  repo.setSetting(SETTING_KEY, JSON.stringify(p));
}

function stageState(p: Progress, n: number): z.infer<typeof StageState> {
  return p.stages[String(n)] ?? { status: "pending", note: "" };
}

/** Set an auto-judged stage's status, preserving its note. */
function setAuto(p: Progress, n: number, ok: boolean): void {
  const st = p.stages[String(n)];
  if (st) st.status = ok ? "passed" : "failed";
}

/** States in which the printer is not idle → refuse to start a dry run (409). */
const BUSY_STATES = new Set(["RUNNING", "PREPARE", "PAUSE", "SLICING"]);
function isBusy(s: PrinterStatusView): boolean {
  return s.printing || BUSY_STATES.has(s.gcode_state);
}

// ── app ───────────────────────────────────────────────────────────────────────

export function createVerifyApp(deps: VerifyDeps): Hono {
  const { repo } = deps;
  const app = new Hono();

  app.get("/verify", (c) => c.html(renderVerifyPage(loadProgress(repo), deps)));
  app.get("/ui/verify", (c) => c.html(renderVerifyInner(loadProgress(repo), deps)));

  // Stage 1-3: run the diagnostics probe and auto-judge from the result.
  app.post("/ui/verify/run-diagnostics", async (c) => {
    const p = loadProgress(repo);
    const r = await deps.runDiagnostics();
    p.diagnostics = {
      ran_at: new Date().toISOString(),
      mqtt_reachable: r.mqtt_reachable,
      ftps_reachable: r.ftps_reachable,
      mqtt_auth_ok: r.mqtt_auth_ok,
      report_received: r.report_received,
      ftps_auth_ok: r.ftps_auth_ok,
      prot_mode: r.prot_mode,
      prot_detail: r.prot_detail,
      sample_report: r.sample_report ? JSON.stringify(r.sample_report, null, 2) : null,
    };
    setAuto(p, 1, r.mqtt_reachable && r.ftps_reachable);
    setAuto(p, 2, r.mqtt_auth_ok && r.report_received);
    setAuto(p, 3, r.ftps_auth_ok);
    saveProgress(repo, p);
    return c.html(renderVerifyInner(p, deps));
  });

  // Stage 4: judge orchestrator reachability from the live printer status.
  app.post("/ui/verify/check-status", async (c) => {
    const p = loadProgress(repo);
    const s = await deps.printerStatus();
    p.printer = { ran_at: new Date().toISOString(), gcode_state: s.gcode_state, printing: s.printing };
    setAuto(p, 4, s.gcode_state === "IDLE");
    saveProgress(repo, p);
    return c.html(renderVerifyInner(p, deps));
  });

  // Stage 5: publish the dry-rehearsal job. `confirmed:true` is mandatory (server
  // mirror of the physical-safety checkbox gate); refuses when the printer is busy.
  // `includeSwap` (optional, defaults false — old clients keep working unchanged)
  // runs the "スワップ込みリハーサル" variant (spec 20.7): the swap profile is
  // appended after the motion test, so the mechanism actually moves a plate.
  app.post("/api/verify/dry-run", async (c) => {
    let body: unknown = null;
    try {
      body = await c.req.json();
    } catch {
      body = null;
    }
    const confirmed = !!body && typeof body === "object" && (body as { confirmed?: unknown }).confirmed === true;
    if (!confirmed) return c.json({ error: "confirmed:true is required" }, 400);
    const includeSwap = !!body && typeof body === "object" && (body as { includeSwap?: unknown }).includeSwap === true;

    const s = await deps.printerStatus();
    if (isBusy(s)) return c.json({ error: "printer is busy; stop the current job first" }, 409);

    try {
      await deps.startDryRun(includeSwap);
    } catch (e) {
      return c.json({ error: (e as Error).message }, 500);
    }
    return c.json({ ok: true });
  });

  // Stage 6: stop + eject. Refuse if a REAL queue job is printing — this raw
  // eject bypasses the dispatcher, so firing it during a queue print would
  // desync the DB and (before the strict-attribution fix) misattribute the
  // eject's FINISH to that job. Stage 6 is meant to abort the Stage 5
  // dry-rehearsal, which is NOT a DB job — so no printing job = allowed.
  app.post("/api/verify/eject", async (c) => {
    if (deps.hasPrintingJob?.()) {
      return c.json({ error: "実キュージョブが印刷中です。中止はダッシュボードの中止ボタンを使ってください" }, 409);
    }
    await deps.eject();
    return c.json({ ok: true });
  });

  // ── TEMPORARY routes (実機検証用 — 確認後に削除, task#16) ────────────────────
  // In-memory last shot: this is throwaway test scaffolding; nothing persists.
  let lastShot: Buffer | null = null;

  // 📸 capture one frame now and hold it for preview/report.
  app.post("/api/verify/test-snapshot", async (c) => {
    if (!deps.testSnapshot) return c.json({ error: "not wired" }, 404);
    const jpeg = await deps.testSnapshot();
    if (!jpeg) return c.json({ error: "カメラからフレームを取得できませんでした" }, 502);
    lastShot = jpeg;
    return c.json({ ok: true, bytes: jpeg.length });
  });

  // preview of the held shot (cache-busted by the client).
  app.get("/api/verify/test-snapshot.jpg", (c) => {
    if (!lastShot) return c.json({ error: "no test snapshot yet" }, 404);
    c.header("content-type", "image/jpeg");
    c.header("cache-control", "no-store");
    return c.body(new Uint8Array(lastShot) as Uint8Array<ArrayBuffer>);
  });

  // 🔔 send the held shot as a photo-attached completion report to Discord.
  app.post("/api/verify/test-photo-report", async (c) => {
    if (!deps.sendPhotoReport) return c.json({ error: "not wired" }, 404);
    if (!lastShot) return c.json({ error: "先に📸撮影テストを実行してください" }, 400);
    const ok = await deps.sendPhotoReport(lastShot, "実機検証テスト: 手動送信");
    return ok ? c.json({ ok: true }) : c.json({ error: "Discord送信に失敗しました (webhook設定を確認)" }, 502);
  });

  // arm/disarm the auto capture on the next print's swap boundary.
  app.post("/ui/verify/auto-capture", async (c) => {
    if (deps.armAutoCapture) {
      const form = await c.req.parseBody();
      deps.armAutoCapture(form.armed === "1");
    }
    return c.html(renderVerifyInner(loadProgress(repo), deps));
  });

  // Manual status + note update for any stage.
  app.post("/ui/verify/stage/:n", async (c) => {
    const n = Number(c.req.param("n"));
    const p = loadProgress(repo);
    const st = p.stages[String(n)];
    if (Number.isInteger(n) && st) {
      const form = await c.req.parseBody();
      const status = form.status;
      if (status === "passed" || status === "failed" || status === "pending") st.status = status;
      if (typeof form.note === "string") st.note = form.note;
      saveProgress(repo, p);
    }
    return c.html(renderVerifyInner(p, deps));
  });

  return app;
}

// ── presentation ───────────────────────────────────────────────────────────────

const STATUS_META: Record<StageStatus, { label: string; cls: string }> = {
  // 赤色は "止まれ" 専用。failed（要確認）は amber に寄せる。
  pending: { label: "未実施", cls: "slate" },
  passed: { label: "合格", cls: "green" },
  failed: { label: "要確認", cls: "amber" },
};

function checkLine(label: string, ok: boolean): Html {
  return html`<li class="chk ${ok ? "ok" : "ng"}">${ok ? "✓" : "✗"} ${label}</li>`;
}

/** Evidence for the automated stages, derived from the last diagnostics run. */
function diagBody(def: StageDef, p: Progress): Html {
  const d = p.diagnostics;
  if (def.n === 1) {
    const runBtn = html`<button
      class="act primary"
      hx-post="/ui/verify/run-diagnostics"
      hx-target="#verify"
      hx-swap="outerHTML"
    >
      接続診断を実行（Stage 1-3 を自動判定）
    </button>`;
    if (!d) return html`<p class="muted">未実行です。下のボタンで診断を実行してください。</p>${runBtn}`;
    return html`<ul class="chk-list">
        ${checkLine("MQTT (8883) TCP 到達", d.mqtt_reachable)}
        ${checkLine("FTPS (990) TCP 到達", d.ftps_reachable)}
      </ul>
      <p class="muted">最終実行 ${d.ran_at}</p>
      ${runBtn}`;
  }
  if (def.n === 2) {
    if (!d) return html`<p class="muted">Stage 1 の診断を実行すると自動判定されます。</p>`;
    return html`<ul class="chk-list">
        ${checkLine("MQTT 認証 (mqtt_auth_ok)", d.mqtt_auth_ok)}
        ${checkLine("report 受信 (report_received)", d.report_received)}
      </ul>
      ${
        d.sample_report
          ? html`<details class="evidence">
              <summary>生 report (sample_report) を表示</summary>
              <pre class="evidence-pre">${d.sample_report}</pre>
            </details>`
          : html`<p class="muted">sample_report は受信していません。</p>`
      }`;
  }
  if (def.n === 3) {
    if (!d) return html`<p class="muted">Stage 1 の診断を実行すると自動判定されます。</p>`;
    return html`<ul class="chk-list">${checkLine("FTPS ログイン (ftps_auth_ok)", d.ftps_auth_ok)}</ul>
      <div class="prot-callout">
        <span class="prot-label">PROT モード（spec 19 ★実測）</span>
        <span class="prot-value prot-${d.prot_mode}">${d.prot_mode}</span>
        ${d.prot_detail ? html`<span class="prot-detail">${d.prot_detail}</span>` : ""}
      </div>`;
  }
  return html``;
}

/** Stage 4: orchestrator reachability. */
function statusBody(p: Progress): Html {
  const s = p.printer;
  const runBtn = html`<button
    class="act primary"
    hx-post="/ui/verify/check-status"
    hx-target="#verify"
    hx-swap="outerHTML"
  >
    ステータスを確認
  </button>`;
  if (!s) return html`<p class="muted">未確認です。下のボタンで /api/printer/status を叩きます。</p>${runBtn}`;
  return html`<ul class="chk-list">${checkLine(`gcode_state = ${s.gcode_state}（IDLE を期待）`, s.gcode_state === "IDLE")}</ul>
    <p class="muted">最終確認 ${s.ran_at}</p>
    ${runBtn}`;
}

/** Stage 5: safety-gated dry-rehearsal run + live progress panel. Includes the
 *  「スワップ込みリハーサル」opt-in: checking it reveals two extra physical
 *  confirmations (the mod itself, and stocker stock), and the run button stays
 *  disabled until ALL currently-relevant checks are ticked (verify.js). */
function dryRunBody(): Html {
  const boxes = SAFETY_CHECKS.map(
    (label, i) => html`<label class="safety">
      <input type="checkbox" data-verify-safety id="safety-${i}" />
      <span>${label}</span>
    </label>`,
  );
  const swapBoxes = SWAP_SAFETY_CHECKS.map(
    (label, i) => html`<label class="safety">
      <input type="checkbox" data-verify-swap-safety id="swap-safety-${i}" />
      <span>${label}</span>
    </label>`,
  );
  return html`
    <div class="safety-list">${boxes}</div>
    <label class="safety">
      <input type="checkbox" id="verifySwapToggle" data-verify-swap-toggle />
      <span>スワップシーケンス込みで実行</span>
    </label>
    <div id="verifySwapExtra" class="safety-list swap-extra" hidden>
      <p class="muted swap-warn">注意: ベッドが Z185・Y±オーバートラベルまで動きます。</p>
      ${swapBoxes}
    </div>
    <button id="verifyDryRun" class="act primary" disabled>ドライリハーサルを実行</button>
    <p id="verifyDryMsg" class="muted"></p>
    <div id="verifyUploadLive" class="dry-live" data-upload-live hidden>
      <div class="printing-head">
        <span class="badge blue">送信</span>
        <span data-upload-msg>—</span>
      </div>
      <div class="progressbar"><div class="prog-bar" style="width:0%"></div></div>
    </div>
    <div id="verifyDryLive" class="dry-live" data-dry-live>
      <div class="printing-head">
        <span class="badge blue">状態</span>
        <span data-dry-state>—</span>
      </div>
      <div class="progressbar"><div class="prog-bar" style="width:0%"></div></div>
      <div class="printing-sub"><span data-dry-pct>—</span></div>
    </div>
  `;
}

/** Stage 6: stop + eject (two-step confirm, wired in verify.js). */
function ejectBody(): Html {
  return html`
    <button id="verifyEject" class="act danger">中止して排出ジョブを送る</button>
    <p id="verifyEjectMsg" class="muted"></p>
  `;
}

/** Stage 7: manual real print. */
function realPrintBody(): Html {
  return html`
    <p>通常 UI から 1 プレートだけ実印刷して仕上げます。</p>
    <p class="muted">
      注意: 通常運用ではスワップ挿入 (SWAP_SNIPPET) は
      <code>profiles/swap-sequence.gcode</code>（実機の交換modシーケンス）が既定です。慎重に検証したい場合は
      env <code>SWAP_SNIPPET</code> を無害な値（例: <code>G1 Z180 F3000 / M400</code>）に一時的に上書きしてから
      実印刷し、確認後に上書きを外すこと。異常があれば一時停止で止められるよう手元で待機。
    </p>
    <a class="act primary" href="/">通常 UI（印刷キュー）を開く</a>
  `;
}

function stageBody(def: StageDef, p: Progress): Html {
  if (def.n <= 3) return diagBody(def, p);
  if (def.n === 4) return statusBody(p);
  if (def.n === 5) return dryRunBody();
  if (def.n === 6) return ejectBody();
  return realPrintBody();
}

/** Per-stage manual note + status controls (works for every stage). */
function manualControls(def: StageDef, state: z.infer<typeof StageState>): Html {
  const mark = (status: StageStatus, label: string, cls = "act") =>
    html`<button
      class="${cls}"
      hx-post="/ui/verify/stage/${def.n}"
      hx-vals="${raw(JSON.stringify({ status }))}"
      hx-include="closest .stage-manual"
      hx-target="#verify"
      hx-swap="outerHTML"
    >
      ${label}
    </button>`;
  return html`<div class="stage-manual">
    <textarea name="note" class="stage-note" placeholder="所見メモ（任意）">${state.note}</textarea>
    <div class="stage-manual-actions">
      ${mark("passed", "合格", "act primary")}
      ${mark("failed", "要確認")}
      ${mark("pending", "未実施に戻す")}
    </div>
  </div>`;
}

function stageCard(def: StageDef, p: Progress): Html {
  const state = stageState(p, def.n);
  const meta = STATUS_META[state.status];
  return html`<li class="card stage-card status-${meta.cls}" data-stage="${def.n}">
    <div class="card-main">
      <div class="card-title">
        <span class="stage-num">Stage ${def.n}</span>
        <span class="filename">${def.title}</span>
        <span class="badge ${meta.cls}">${meta.label}</span>
        <span class="stage-kind">${def.auto ? "自動判定" : "手動"}</span>
      </div>
      <p class="stage-desc">${def.desc}</p>
      ${
        def.manualChecks && def.manualChecks.length > 0
          ? html`<ul class="manual-checks">
              ${def.manualChecks.map((m) => html`<li>確認項目: ${m}</li>`)}
            </ul>`
          : ""
      }
      <div class="stage-body">${stageBody(def, p)}</div>
      ${manualControls(def, state)}
    </div>
  </li>`;
}

/** The reactive fragment (#verify) — everything htmx swaps in place. */
function renderVerifyInner(p: Progress, deps?: VerifyDeps): Html {
  return html`<div id="verify">
    <ol class="queue stage-list">${STAGES.map((s) => stageCard(s, p))}</ol>
    ${deps ? tempPhotoSection(deps) : ""}
  </div>`;
}

/** ── TEMPORARY (実機検証用 — 確認後に削除, task#16) ──────────────────────────
 *  swap直前スナップショット+Discord写真付き完成報告のフィールドテスト。
 *  deps が配線されていない環境(テスト/一部ハーネス)では丸ごと非表示。 */
function tempPhotoSection(deps: VerifyDeps): Html {
  if (!deps.testSnapshot && !deps.sendPhotoReport && !deps.autoCaptureState) return html``;
  const auto = deps.autoCaptureState?.() ?? { armed: false, fired: null };
  return html`
    <section class="banner amber" id="tempPhotoTest">
      <div class="banner-head"><span class="banner-count">一時検証: swap直前スナップ+Discord報告</span></div>
      <p class="muted">確認後に削除される一時機能です。カメラ→保存→Discord添付のパイプラインを実機で検証します。</p>
      <div class="stage-body">
        <button class="act" id="tempShotBtn" ${deps.testSnapshot ? "" : "disabled"}>📸 撮影テスト</button>
        <button class="act" id="tempReportBtn" ${deps.sendPhotoReport ? "" : "disabled"}>🔔 写真付き完成報告テスト (Discord)</button>
        <p id="tempPhotoMsg" class="muted"></p>
        <img id="tempShotImg" class="snapshot" alt="" hidden />
        ${
          deps.armAutoCapture
            ? html`<div class="temp-auto">
                <label>
                  <input type="checkbox" id="tempAutoArm" ${auto.armed ? "checked" : ""} />
                  次の印刷で自動撮影+Discord送信（RUNNING中に layer==total 到達で発火。レイヤー情報が無い場合は FINISH 遷移で発火）
                </label>
                ${
                  auto.fired
                    ? html`<p class="muted">前回発火: ${auto.fired.trigger} / ${auto.fired.at} / Discord送信 ${auto.fired.photoSent ? "✓" : "✗"}</p>`
                    : html`<p class="muted">まだ発火していません</p>`
                }
              </div>`
            : ""
        }
      </div>
    </section>
  `;
}

function nav(active: "queue" | "projects" | "verify"): Html {
  const cls = (k: string) => (k === active ? "navlink active" : "navlink");
  return html`<nav class="nav">
    <a class="${cls("queue")}" href="/">キュー</a>
    <a class="${cls("projects")}" href="/projects">プロジェクト</a>
    <a class="${cls("verify")}" href="/verify">実機検証</a>
  </nav>`;
}

function renderVerifyPage(p: Progress, deps?: VerifyDeps): Html {
  return html`<!doctype html>
<html lang="ja">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>実機検証ガイド — Auto-swap</title>
  <script src="/vendor/htmx.min.js" defer></script>
  <link rel="stylesheet" href="/vendor/app.css" />
</head>
<body>
  <header class="topbar">
    <h1>実機検証ガイド</h1>
    ${nav("verify")}
    <span id="connChip" class="conn-chip" hidden>接続が切れました。表示が古い可能性があります</span>
  </header>
  <main>
    <p class="verify-intro muted">
      Windows ラップトップから A1 mini 実機を初めて叩くときの検証工程です。自動判定できるものは自動、
      物理確認は明示チェック。進捗と所見は保存されます。
    </p>
    ${renderVerifyInner(p, deps)}
  </main>
  <script src="/vendor/shared.js" defer></script>
  <script src="/vendor/verify.js" defer></script>
</body>
</html>`;
}
