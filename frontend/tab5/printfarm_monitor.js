// @app printfarm
// @title プリントファーム
// @icon 🖨️
// @desc A1 mini キュー/進捗モニタ（自前Mosquitto printfarm/* を購読）
// @perm ui,mqtt
//
// M5Stack Tab5 用 mqjs アプリ（ES5 サブセット）。
// 設計・API・ペイロード契約: docs/m5stack-tab5-frontend-research.md
//
// 読み取り専用ダッシュボード:
//   printfarm/current/progress (retained) -> 上段 進捗バー
//   printfarm/queue            (retained) -> 中段 キュー一覧 + ストッカー
//   printfarm/event            (非retain) -> 下段 直近イベント（対応待ちは赤帯）
// retain のおかげで購読直後に最新状態が届く。
"use strict";
sys.setAppName("printfarm");

// ── 設定 ─────────────────────────────────────────────────────────────────────
// 空文字 = ファームウェアの既定ブローカー（sdkconfig）を使う ← 公開リポジトリ向けの既定。
// 環境固有アドレス（コントローラホストの Tailscale MagicDNS 名など）はコミットせず、デプロイ
// 時に端末側の設定（sdkconfig / 端末ローカル）で与える。開発機で手早く試すだけなら、この行を
// ローカルで一時的に "mqtt://<controller の tailnet アドレス>:1883" に書き換える（コミットしない）。
var BROKER = "";
var T_PROGRESS = "printfarm/current/progress";
var T_QUEUE = "printfarm/queue";
var T_EVENT = "printfarm/event";

// ── 画面 ─────────────────────────────────────────────────────────────────────
var HAS_UI = ui.size()[0] !== 0;
var W = ui.size()[0], H = ui.size()[1];

var BG = 0x101820, FG = 0xE0E6EA, DIM = 0x8794A0;
var BAR_BG = 0x2A3A44, BAR_FG = 0x4FC3F7, PANEL = 0x18242C;

// ── モデル ────────────────────────────────────────────────────────────────────
var model = {
    progress: null,   // {subtask_name, gcode_state, percent, layer, total_layer, remaining_min, eta_epoch_ms}
    queue: [],        // [{id, filename, status, project, position, eta_epoch_ms, substituted}]
    stocker: null,    // {remaining, capacity}
    lastEvent: null,  // {type, severity, message, ts}
    connected: 0
};
var dirty = true;
var token = null;     // net capability token（再接続用に保持）

// ── ユーティリティ ───────────────────────────────────────────────────────────
function parseJSON(s) {
    try { return JSON.parse(s); } catch (e) { print("[printfarm] bad json: " + e); return null; }
}

function statusColor(status) {
    if (status === "printing") return 0x4FC3F7;
    if (status === "success") return 0x2ECC71;
    if (status === "failed" || status === "aborted") return 0xE05A4E;
    if (status === "waiting_for_refill") return 0xFFB347;
    if (status === "queued") return 0x6B7B87;
    return 0x9AA7B0; // processing 等
}

function eventBandColor(ev) {
    if (!ev) return PANEL;
    if (ev.type === "job_failed") return 0x5A1E1A;
    if (ev.severity === "blocking_queue" || ev.severity === "blocking_job") return 0x5A1E1A;
    if (ev.type === "waiting_for_refill") return 0x5A3A16;
    return PANEL;
}

function two(n) { return (n < 10 ? "0" : "") + n; }

function clock(ms) {
    if (!ms) return "--:--";
    var d = new Date(ms);
    return two(d.getHours()) + ":" + two(d.getMinutes());
}

function fmtMin(m) {
    if (m == null) return "";
    if (m < 60) return m + "分";
    return Math.floor(m / 60) + "時間" + two(m % 60) + "分";
}

// ── 描画 ─────────────────────────────────────────────────────────────────────
function render() {
    if (!HAS_UI) return;
    ui.clear(BG);

    // 接続インジケータ + 再接続ボタン（右上 □）
    ui.text(24, 16, "プリントファーム", FG);
    ui.text(300, 16, model.connected ? "● 接続中" : "○ 未接続",
            model.connected ? 0x2ECC71 : 0xE05A4E);
    ui.rect(W - 72, 8, 56, 56, 0x2E6BD6);
    ui.text(W - 62, 26, "⟳", FG);

    // ── 上段: 現在の印刷進捗 ──
    var p = model.progress;
    if (p && p.gcode_state === "RUNNING") {
        ui.text(24, 60, "印刷中: " + (p.subtask_name || ""), FG);
        var pct = Math.max(0, Math.min(100, p.percent || 0));
        ui.rect(24, 92, W - 48, 36, BAR_BG);
        ui.rect(24, 92, Math.floor((W - 48) * pct / 100), 36, BAR_FG);
        ui.text(28, 100, pct + "%", 0x0A0F14);
        ui.text(24, 138,
            "残り " + fmtMin(p.remaining_min) +
            "  /  layer " + (p.layer || 0) + "/" + (p.total_layer || 0) +
            "  /  完了予定 " + clock(p.eta_epoch_ms) +
            (p.project_eta_epoch_ms ? "  (PJ全体 " + clock(p.project_eta_epoch_ms) + ")" : ""),
            DIM);
    } else {
        ui.text(24, 92, p ? ("状態: " + p.gcode_state) : "印刷なし（待機中）", DIM);
    }

    // ── 中段: キュー一覧 ──
    var y = 180;
    ui.text(24, y, "キュー (" + model.queue.length + ")", FG);
    y += 30;
    var rowH = 44, i;
    for (i = 0; i < model.queue.length && y < H - 130; i++) {
        var j = model.queue[i];
        ui.rect(24, y, W - 48, rowH - 8, PANEL);
        ui.rect(24, y, 8, rowH - 8, statusColor(j.status)); // 左端の状態バー
        ui.text(44, y + 8, "#" + (j.position != null ? j.position : "-") + "  " + (j.filename || ""), FG);
        var meta = j.status + (j.project ? "  [" + j.project + "]" : "") +
                   (j.eta_epoch_ms ? "  ~" + clock(j.eta_epoch_ms) : "");
        ui.text(44, y + 24, meta, DIM);
        if (j.substituted) ui.text(W - 220, y + 8, "⚠ 色代替あり", 0xFFB347);
        y += rowH;
    }

    // ── 下段: ストッカー + 直近イベント ──
    var fy = H - 110;
    var st = model.stocker;
    ui.rect(24, fy, W - 48, 92, eventBandColor(model.lastEvent));
    ui.text(40, fy + 12,
        "ストッカー: " + (st ? (st.remaining + " / " + st.capacity) : "?") +
        (st && st.remaining <= 0 ? "  ← 補充が必要" : ""),
        st && st.remaining <= 0 ? 0xFFB347 : FG);
    if (model.lastEvent) {
        ui.text(40, fy + 48, model.lastEvent.message || model.lastEvent.type, FG);
    }
}

function invalidate() { dirty = true; }

// ── MQTT ──────────────────────────────────────────────────────────────────────
function wireSubscriptions() {
    mqtt.subscribe(T_PROGRESS, function (t, payload) {
        var v = parseJSON(payload);
        if (v) { model.progress = v; invalidate(); }
    });
    mqtt.subscribe(T_QUEUE, function (t, payload) {
        var v = parseJSON(payload);
        if (v) {
            model.queue = v.jobs || [];
            model.stocker = v.stocker || model.stocker;
            invalidate();
        }
    });
    mqtt.subscribe(T_EVENT, function (t, payload) {
        var v = parseJSON(payload);
        if (v) { model.lastEvent = v; invalidate(); }
    });
}

mqtt.onConnect(function () {
    model.connected = 1;
    print("[printfarm] connected");
    invalidate();
});

function connect() {
    if (!token) return;
    if (BROKER) mqtt.connect(token, BROKER); else mqtt.connect(token);
}

// 接続前に subscribe しておくと接続時にまとめて購読され、retained が即届く。
wireSubscriptions();
net.onReady(function (tok) {
    token = tok;
    connect();
});

// ── ループ / タッチ ───────────────────────────────────────────────────────────
// render は dirty のときだけ（描画コスト + 5秒ウォッチドッグ対策）。接続状態も追う。
setInterval(function () {
    var c = mqtt.connected();
    if (c !== model.connected) { model.connected = c; dirty = true; }
    if (dirty) { dirty = false; render(); }
}, 500);

if (HAS_UI) {
    render();
    sys.onForeground(function () { dirty = true; render(); });
    ui.onTouch(function (x, y, kind) {
        if (kind !== 0) return;                 // down のみ
        if (x > W - 80 && y < 72) {             // 右上 □: 再接続
            if (!mqtt.connected()) connect();
            invalidate();
        }
    });
} else {
    print("[printfarm] headless: printfarm/* を購読して print 出力します");
}
