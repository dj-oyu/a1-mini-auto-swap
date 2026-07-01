# M5Stack Tab5 フロントエンド事前調査（mqjs アプリ）

本システム（A1 mini マルチプレート自動印刷）の **IoT監視ディスプレイ**（spec 3章・16章の
「M5Stack等、ジョブ監視用ディスプレイ」）を、ユーザー既存の Tab5 ファームウェア
[`dj-oyu/esp32p4-mqjs`](https://github.com/dj-oyu/esp32p4-mqjs) 上の **mqjs アプリ**として
実装するための事前調査。最終成果物は、自前 Mosquitto（spec 16章）の `printfarm/*` を購読して
キュー・進捗・対応待ちを表示する読み取り専用ダッシュボード。

---

## 1. ハードウェア（M5Stack Tab5）

| 項目 | 値 |
|---|---|
| SoC | ESP32-P4（RISC-V, デュアルコア） + ESP32-C6-MINI（WiFi6 コプロセッサ） |
| メモリ | 16MB Flash / 32MB PSRAM |
| ディスプレイ | **5インチ IPS 1280×720**、MIPI-DSI |
| タッチ | GT911 静電容量マルチタッチ |
| カメラ | SC2356 2MP（本用途では未使用） |
| 電源 | NP-F550 着脱式リチウム、INA226 電力監視 |

横長の大画面なので、上段=現在の印刷進捗、中段=キュー一覧、下段=ストッカー/対応待ち、という
ダッシュボードレイアウトが取りやすい。

---

## 2. mqjs ファームウェアのアプリモデル

`esp32p4-mqjs` は **mquickjs（軽量JSエンジン）** を組み込み、C/C++ を再ビルドせずに
**JS スクリプトを MQTT 経由で動的配信・実行**する「小さなアプリ実行環境」。default branch: `main`。

- **言語**：ECMAScript 5 サブセット。**`let`/`const`/アロー関数/Promise/`async` は不可**。`var` と
  `function` のみ。IIFE でクロージャを作る（例参照）。
- **アプリ形式**：先頭にマニフェストコメント、`"use strict"`、`sys.setAppName()`、トップレベルは
  即時実行、ライフサイクルはフック（`sys.onForeground` 等）。

```javascript
// @app printfarm
// @title プリントファーム
// @icon 🖨️
// @desc A1 mini キュー/進捗モニタ
// @perm ui,mqtt
"use strict";
sys.setAppName("printfarm");
// …トップレベルが即実行される…
```

- **リソース制約**（アプリ設計の絶対条件）：
  - アプリごと **256 KiB メモリアリーナ**
  - **単一コールバックは 5 秒でウォッチドッグ**（MQTT ハンドラも render も 5 秒以内で返す）
  - **MQTT 配信サイズ上限 64 KiB**（アプリ本体のサイズ）
  - 4 コンテキストの協調スケジューリング（他アプリと共存）

- **配信/デプロイ**：`tools/mqjs_push.py` が Ed25519 署名して MQTT retained で配信。
  - 開発スロット差し替え：`TASK_TOPIC` に publish
  - インストール型アプリ：`TASK_TOPIC/apps/<name>`（+ カタログ `TASK_TOPIC/store/<name>`、`--shelf`）
  - 端末が受信→署名検証→LittleFS 保存→即実行
  - 鍵生成 `tools/mqjs_keygen.py`、ブラウザ編集UI `tools/mqjs_webui.py`
  - ブローカーURL/SSID/TASK_TOPIC は `sdkconfig.tab5.defaults` に設定

```bash
# 例：アプリを署名して配信
uv run --with cryptography python tools/mqjs_push.py <BROKER_IP> $TASK_TOPIC printfarm_monitor.js --shelf
```

---

## 3. JS API リファレンス（実例から確定）

`examples/mqtt_demo.js`・`examples/touch_demo.js` の実コードから抽出した確定シグネチャ。

### net（リンク確立とトークン）
```javascript
net.onReady(function (token) { ... });   // WiFiリンク確立時に capability token を渡す
```
- **`mqtt.connect` は token 無しでは呼べない**。必ず `net.onReady` 内で接続する。

### mqtt
```javascript
mqtt.connect(token, "mqtt://host[:port]"); // uri 省略でプラットフォーム既定ブローカー
mqtt.onConnect(function () { ... });        // 接続確立ごと（再接続でも）に発火
mqtt.subscribe(topic, function (topic, payload) { ... }); // payload は string。+/# 可
mqtt.publish(topic, payload, qos, retain);  // qos/retain 省略可
mqtt.connected();                           // 1/0
mqtt.disconnect();
```
- **接続前に subscribe してよい**（接続時にまとめて購読される）。retained メッセージは購読直後に届く
  → 起動直後に最新のキュー/進捗が即座に埋まる（spec 16章の retain 設計と噛み合う）。
- payload は文字列。JSON は `JSON.parse` する。

### ui（キャンバス＋ウィジェットのハイブリッド）
```javascript
ui.size();                       // [width, height]。[0]===0 なら画面なし（ヘッドレス機）
ui.clear(color);                 // 全面塗り（0xRRGGBB）
ui.text(x, y, str, color);
ui.rect(x, y, w, h, color);      // 塗り矩形
ui.line(x1, y1, x2, y2, color);
ui.onTouch(function (x, y, kind) { ... }); // kind: 0=down,1=move,2=up
ui.back;                         // 直前画面へ（リテインスタックが回収）。s.button のcbに直接渡せる

var s = ui.screen(title);        // モーダルなウィジェット画面を作る
var lbl = s.label(text);   lbl.setText(newText);   // 動的更新可
s.button(label, fn);
s.toggle(label, initial /*0|1*/, function (v) { ... });
s.slider(min, max, initial, function (v) { ... });
var l = s.list();  l.add(label, fn);   // 選択リスト
s.input(...)                     // テキスト入力（詳細は要確認）
```

**描画モデル**：キャンバスは即時反映（明示 redraw 不要）。ウィジェット画面はキャンバスに重なる
モーダル。閉じるのは必ず `ui.back()`。**画面はアプリ切替時に破棄される**ので、初回描画とフォア
グラウンド復帰を同じ関数で組み立て、`sys.onForeground(build)` に登録するのが定石。

### sys / グローバル
```javascript
sys.setAppName(name);
sys.onForeground(fn);   // 前面復帰。画面破棄後の再構築に使う
sys.onStop(fn);         // 停止時クリーンアップ
print(...), console.log(...);
setInterval(fn, ms), setTimeout(fn, ms);
Date, performance.now();
```

### ヘッドレス両対応イディオム
```javascript
var HAS_UI = ui.size()[0] !== 0;
// MQTT 等のコアは常に動かし、UI 構築は HAS_UI のときだけ。setText 先はダミーで no-op 化。
```

---

## 4. 本システムとの接続（spec 16章ゲートウェイ）

Tab5 は **A1 mini 本体には接続しない**。コントローラホスト上の自前 Mosquitto のみを購読する
（spec 2/16章、接続数制限対策）。オーケストレーターが「正規化データを再publish」した
`printfarm/*` を読む。

**デプロイ/ネットワーク前提**：オーケストレーターと Mosquitto は **コントローラホスト（arm64
Linux）** で常時稼働し、機器間は **Tailscale** で接続する。したがって Tab5 のブローカー URL は
LAN IP ではなく **コントローラホストの Tailscale アドレス（MagicDNS 名など）**を指す。tailnet は
暗号化済みのため 1883 平文で足りる。mqjs ファーム側も tailscale 統合を持つため、tailnet 上で
完結できる。

> ⚠️ **環境固有アドレス（tailnet IP / MagicDNS 名 / アクセスコード等）はリポジトリにコミット
> しない**（公開GitHub前提）。`.env`（ルート、gitignore 済み）と `.env.example` で管理し、
> Tab5 側はアプリの `BROKER` を空にしてファーム sdkconfig の既定に委ねるか、デプロイ時に注入する。
> 具体的な tailnet アドレスは各自の `tailscale status` で確認する。

```
オーケストレーター(コントローラホスト) ──正規化re-publish──▶ 自前Mosquitto ──▶ Tab5 mqjs アプリ(購読のみ)
```

| トピック | retain | 用途 |
|---|---|---|
| `printfarm/queue` | ✅ | キュー全体スナップショット |
| `printfarm/queue/{job_id}/status` | ✅ | 個別ジョブ状態 |
| `printfarm/current/progress` | ✅ | 現在印刷の progress%/eta/layer |
| `printfarm/event` | ❌ | job_started/finished/failed 等の一過性トリガー |

retain のおかげで、アプリ起動＝購読直後に最新の全体像が届く。

---

## 5. `printfarm/*` ペイロード契約（提案・要ラチファイ）

spec 16章はトピックのみ規定でペイロード未定義のため、オーケストレーター（Phase 7 ゲートウェイ）と
Tab5 アプリの**両者が従う JSON 契約**をここで提案する。spec 4章（jobs）/10章（ETA）/11章（stocker）
/13章（pending_actions）に整合。

```jsonc
// printfarm/current/progress  (retained)
{
  "job_id": 12,
  "subtask_name": "plate_03.gcode.3mf",
  "gcode_state": "RUNNING",        // IDLE|PREPARE|RUNNING|PAUSE|FINISH|FAILED
  "percent": 42,                    // 0..100 (MQTT mc_percent 由来)
  "layer": 88, "total_layer": 210,
  "remaining_min": 63,              // mc_remaining_time
  "eta_epoch_ms": 1751330000000,    // このプレート完了予定 (spec 10章)
  "project_eta_epoch_ms": 1751360000000 // 所属プロジェクト全体 (null 可)
}
```
```jsonc
// printfarm/queue  (retained)
{
  "jobs": [
    { "id": 12, "filename": "plate_03.gcode.3mf", "status": "printing",
      "project": "myproj", "position": 1, "attempts": 0,
      "eta_epoch_ms": 1751330000000, "substituted": false }
    // status: processing|queued|printing|success|failed|aborted|waiting_for_refill
  ],
  "stocker": { "remaining": 7, "capacity": 10 },
  "updated_at": "2026-07-01T00:00:00Z"
}
```
```jsonc
// printfarm/queue/{job_id}/status  (retained) — 上の jobs[] 要素と同型の単体
{ "id": 12, "filename": "…", "status": "printing", "project": "myproj",
  "position": 1, "attempts": 0, "eta_epoch_ms": …, "substituted": false }
```
```jsonc
// printfarm/event  (非retain)
{
  "type": "job_finished",           // job_started|job_finished|job_failed|waiting_for_refill|pending_action
  "job_id": 12,
  "severity": "advisory",           // advisory|blocking_job|blocking_queue (pending_action時)
  "message": "✅ plate_03 完了（一部フィラメントが自動切替されました、確認推奨）",
  "ts": 1751330000000
}
```
> spec 14章の「代替色は完了通知に必ず反映」を `event.message` と `queue.jobs[].substituted` の両方で
> 表現する。Tab5 側はバッジ + イベントトーストで二重に可視化する。

---

## 6. アプリ設計（printfarm モニタ）

**モデル駆動 + キャンバス描画**。MQTT ハンドラは model を更新して `render()` を呼ぶだけ（<5秒厳守）。

- 状態 `model = { progress, queue:[], stocker, lastEvent, connected }`
- `render()`：`ui.clear` → 上段に現在ジョブの進捗バー（`ui.rect` で外枠+塗り）・%/ETA/layer、
  中段にキュー一覧（position・ファイル名・状態バッジ色・per-job ETA）、下段にストッカー残数と
  直近イベント（対応待ちは赤帯）。接続状態を隅に表示。
- 更新の間引き：`printfarm/current/progress` は最大 1〜2Hz。`render()` を `setInterval` で ~500ms
  ごとに1回、dirty フラグ立ってれば描くパターンで、ウォッチドッグと描画コストを抑える。
- `sys.onForeground(render)` で画面破棄後に再構築。`ui.size()[0]===0` ならヘッドレスとして
  `print()` にだけ出す。
- タッチ（v1）：右上に「再接続」□。ジョブ tap で詳細（`ui.screen` のモーダルに job 情報 + 将来的に
  abort/retry を publish するボタン→ただし操作系は spec 上 Web アプリが主。まず読み取り専用）。

状態バッジ配色（案）：printing=水色, queued=灰, success=緑, failed=赤, waiting_for_refill=橙,
pending(blocking)=赤点滅相当（枠強調）。

first-cut 実装：`frontend/tab5/printfarm_monitor.js`（本調査と同時に作成）。

---

## 7. 制約・落とし穴チェックリスト

- [ ] **ES5 のみ**：`let/const/arrow/Promise/async/テンプレートリテラル/分割代入` 不可。`var`+`function`+IIFE。
- [ ] **64 KiB 上限**：アプリを1ファイルに収め、JSON整形やコメントで肥大化させない。
- [ ] **5 秒ウォッチドッグ**：`JSON.parse` する payload は 64KiB 未満想定だが、`printfarm/queue` が
      巨大化しないようジョブ数上限を設ける（オーケストレーター側で要検討）。
- [ ] **token 必須**：`net.onReady` を待ってから `mqtt.connect(token, uri)`。
- [ ] **画面破棄**：フォアグラウンド復帰で再構築。ウィジェット参照は毎回作り直す。
- [ ] **画像なし**：サムネイル表示は困難（HTTP GET は可だが 64KiB/5s 制約と PSRAM を考慮）。v1 は
      テキスト/カラーバッジのみ。
- [ ] **retain 依存**：起動時の即時反映は retain 前提。ゲートウェイが確実に retain publish すること。
- [ ] payload 文字列は UTF-8。日本語メッセージOK（例も日本語）。

---

## 8. 実機ファームウェアに対する要確認事項

ユーザー既存の Tab5 ファームウェアに合わせるため、次を実機/リポジトリで確定する：

1. **ブローカー設定**：ブローカーはコントローラホストの Mosquitto を **Tailscale アドレス/MagicDNS** で
   指す（§4 参照）。`sdkconfig.tab5.defaults` の既定に入れるか、アプリ内 `BROKER` に明示するか。
   実機の tailnet 名（`*.ts.net`）を確定する。
2. **`@perm` の許可トークン**：`ui,mqtt` で足りるか（`net` 権限の要否）。
3. **`s.input` と一覧の詳細シグネチャ**（本調査は label/button/toggle/slider/list を実例確定。
   スクロール可能な長いリスト表示の作法＝`docs/widget-framework-design.md` を実機で確認）。
4. **TASK_TOPIC** の値と、`printfarm/*` と名前空間衝突しないこと。
5. **フォント/日本語グリフ**が UI テキストで出るか（`ui.text` の日本語対応）。
6. 進捗バーに使える専用ウィジェットの有無（無ければ `ui.rect` 2枚で自作）。

---

## 参考出典
- リポジトリ: [dj-oyu/esp32p4-mqjs](https://github.com/dj-oyu/esp32p4-mqjs)（README, `examples/mqtt_demo.js`, `examples/touch_demo.js`, `docs/`）
- [M5Stack Tab5 製品ページ](https://shop.m5stack.com/products/m5stack-tab5-iot-development-kit-esp32-p4)
- [Tab5 - m5-docs](https://docs.m5stack.com/en/core/Tab5)
- [M5Stack Tab5 Review (CNX Software)](https://www.cnx-software.com/2025/05/14/m5stack-tab5-review-part-1-unboxing-teardown-and-first-try-of-the-esp32-p4-and-esp32-c6-5-inch-iot-devkit/)
