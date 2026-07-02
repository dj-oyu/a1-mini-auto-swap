# Bambu A1 mini マルチプレート自動印刷システム 仕様書

## 0. 目的

Bambu Lab A1 mini + BMCU 370C（多色印刷）環境において、Niiさんの自動ビルドプレート交換mod（MakerWorld #925870、kespro/stoked remix適用）を用いて複数プレートを連続印刷するための、コントローラホスト（常時起動のarm64 Linux）上で動作するセルフホスト・ノークラウドの管理システムを構築する。

Bambu Cloud / Bambu Handyには依存せず、LAN内で完結する。

---

## 1. ハードウェア前提

| 項目 | 内容 |
|---|---|
| プリンター | Bambu Lab A1 mini（AMSなし単体） |
| 多色機構 | BMCU 370C |
| プレート自動化 | Niiさん版 自動ビルドプレート交換mod（MakerWorld #925870） |
| 追加remix | kespro「Improved build plate adapter」、stoked「Plate Guiderail」 |
| ホスト | コントローラホスト（常時起動のarm64 Linux、同一LAN/tailnet） |
| カメラ | MIPI CSI ×2（本仕様の対象外。可動カメラマウントは別仕様） |

既知の制約：
- ストッカー容量は機構依存の固定値（`capacity`として設定で持つ）
- 振動でプレートが滑る既知の不具合あり。運用上は完全無人ではなく異常検知→通知の半自動運用とする

---

## 2. プリンター側ネットワーク設定（前提条件）

| 設定 | 値 | 理由 |
|---|---|---|
| LAN Only Mode | ON | クラウド非依存の方針に合致 |
| Developer Mode | ON | 書き込み系MQTTコマンド（print開始/停止/移動/AMS操作/gcode_line）はLAN Onlyのみでは不可。Developer Modeの併用が必須 |
| Bambu Handy | 使用不可（LAN Only化で接続不能になる） | 緊急時の手動操作は本システムのWebアプリ側に実装する |

通信仕様：
- MQTT: ポート8883、TLS（証明書検証は無効化、アクセスコードをパスワードに使用）
- FTPS: ポート990、**implicit FTPS**（一般的なFTPS:21とは異なる点に注意）
- 同時接続上限が2〜3クライアントと少ないため、プリンターのMQTT/FTPSに直接接続するのは本システムのオーケストレーターのみとし、他のクライアント（ブラウザ・IoTデバイス）は後述のゲートウェイ経由とする

---

## 3. 全体アーキテクチャ

```
A1 mini (MQTT:8883 / FTPS:990)
   ⇅
オーケストレーター (Bun + Hono, コントローラホスト)
   ├─ MQTT client … report購読 / コマンドpublish
   ├─ FTPS client … gcode.3mfアップロード
   ├─ キューstate machine (SQLite)
   ├─ 3MF抽出パイプライン（サムネ／メッシュ／フィラメント）
   ├─ ヘッドレススライス（将来: STLアップロード→OrcaSlicer CLI）
   ├─ Webhook dispatcher (Discord / Slack)
   ├─ HTTPサーバー（Webアプリ用 + SSE）
   └─ 正規化データを自前Mosquittoへ再publish
自前Mosquitto (コントローラホスト、ローカルのみ)
   ⇅
IoTデバイス（M5Stack等、ジョブ監視用ディスプレイ）
```

設計原則：A1 mini本体への直接接続はオーケストレーター1点に集約し、他はすべてオーケストレーター経由にする（接続数制限対策）。

---

## 4. データモデル（SQLite）

```sql
CREATE TABLE projects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  color_consistency_policy TEXT NOT NULL DEFAULT 'strict',
    -- 'strict'：代替色が起きたプレート完了時点で、同プロジェクトの後続プレートは停止して判断を仰ぐ
    -- 'propagate'：代替色を後続プレート全部にも自動適用して完走させる
  created_at TEXT,
  updated_at TEXT
);

CREATE TABLE jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER REFERENCES projects(id), -- NULL可（単発プレートも許容）
  filename TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'processing',
    -- processing / queued / printing / success / failed / aborted / waiting_for_refill
  position INTEGER,
  attempts INTEGER DEFAULT 0,
  last_error TEXT,
  thumbnail_path TEXT,
  mesh_json_path TEXT,
  filaments TEXT,          -- JSON: [{slot, color, type}]
  ams_mapping TEXT,         -- JSON: 4要素配列 [-1,-1,0,-1] 形式
  estimated_seconds INTEGER,
  substituted_slot INTEGER,        -- フィラメント切れ自動代替が発生した場合のスロット
  substituted_color TEXT,           -- 代替後の実際の色（元色と異なる場合のみ）
  filament_runout_policy_override TEXT, -- NULL = システム設定を継承
  created_at TEXT,
  updated_at TEXT
);

CREATE TABLE stocker_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  capacity INTEGER NOT NULL,
  remaining INTEGER NOT NULL
);

CREATE TABLE system_settings (
  key TEXT PRIMARY KEY,
  value TEXT
  -- filament_runout_policy: 'manual' | 'same_color_only' | 'allow_material_match'
);

CREATE TABLE pending_actions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL,
    -- filament_confirm / stocker_refill / retry_decision / filament_runout / color_decision / mechanical_check
  job_id INTEGER,
  project_id INTEGER,
  severity TEXT NOT NULL,    -- blocking_queue / blocking_job / advisory
  message TEXT,
  snapshot_path TEXT,
  created_at TEXT,
  notified_at TEXT,
  resolved_at TEXT
);
```

---

## 5. 3MFファイル構造とパース仕様

`.gcode.3mf` はZIPアーカイブ。

```
3D/3dmodel.model              ← ジオメトリ（頂点・三角形・paint_color）
Metadata/
  project_settings.config     ← JSON: filament_colour[], filament_type[] (0-based)
  model_settings.config       ← XML: プレート配置
  slice_info.config           ← XML: フィラメント使用量・時間見積もり
  plate_1.gcode                ← 実G-code（注入対象）
  plate_1.png 他サムネイル各種
```

- `paint_color`：三角形ごとにどのフィラメントスロットが塗られているかを示すビットマスク文字列。高indexから低indexの順にコードを剥がしてデコードする
- 抽出時の注意：再スライス後は`filament_id`がリセット/空になりAMSマッピングが外部スプール扱いにフォールバックする既知の不具合がある。**アップロードのたびに必ず最新configから再抽出し、古いメタデータをキャッシュしない**

---

## 6. パイプライン全体

```
① アップロード（gcode.3mf、将来的にはSTL）
    ↓
② 抽出（サムネ／メッシュ／フィラメント情報、project_settings.config基準）
    ↓
③ 印刷用プロファイル適用確認
    （プロファイル自体に交換シーケンスが焼き込み済み。
     人間によるBambu Studio個別編集は不要）
    ↓
④ フィラメント確認・AMSマッピング確定（人間の操作、3Dプレビューで色確認）
    ↓
⑤ キュー投入（status: queued、プロジェクトへの所属を設定）
    ↓
⑥ ディスパッチ（ストッカー残数チェック→プロジェクトのブロック状態チェック→FTPSアップロード→MQTT印刷開始）
    ↓
⑦ 監視ループ（MQTT status / gcode_state / HMS購読、ETA計算）
    ↓
⑧-A 正常終了                    ⑧-B 異常終了 / タイムアウト
    ↓                                ↓
 交換シーケンスはgcodeに         MQTT stopコマンド
 焼き込み済みのため自動実行         ↓
    ↓                            排出専用ジョブ送信（ホーミング＋交換）
 ストッカー残数 -1                  ↓
    ↓                            ストッカー残数 -1、status: failed
 通知（成功）、status: success       通知（失敗）→pending_actions登録
    ↓                                ↓
⑨ 次のqueuedへ ←────────────（Webアプリからretry操作があれば再キュー）
```

ストッカー残数が0になった場合、⑥の時点で `waiting_for_refill` に遷移し、人間が物理補充→`/api/stocker/refill` を呼ぶまでループは止まる。

---

## 7. G-code注入の方針

> 既存OSS（`maziggy/bambuddy`）が同種の機能を「Auto-print G-code injection」として実装済み（Farmloop/SwapMod/AutoClear/Printflow 3D対応）。以下はその設計を参考に修正したもの。

- 交換シーケンス（`G1 Z180 F3000 ...`一式）は、**Bambu Studioの手動設定ではなく、サーバー側で管理する印刷用プロファイル（JSON、リポジトリ管理）に焼き込んでおく**
- 将来的にSTLを直接アップロードする運用になった場合、このプロファイルを使ってOrcaSlicer CLI等でヘッドレススライスし、最初から交換シーケンス込みのgcode.3mfを生成する
- 当面の運用（人間がスライス済みgcode.3mfをアップロード）では、念のためアップロード時に交換シーケンスの有無をgcode内検索でチェックし、無ければ追記するフォールバックを設ける

**注入位置**
- 開始側が必要な場合：`; MACHINE_START_GCODE_END` マーカーに注入する。これはBambu/Orcaスライサーが生成するMACHINE_START_GCODEブロック末尾（M109温度待ち後）に必ず存在し、スライサー側のカスタムstart-gcodeが入る位置と一致する。マーカーが無い古い出力では先頭prependにフォールバックし、警告ログを出す
- 終了側（本システムの主用途）：マーカー探索は不要。**印刷G-codeの最終行の後にそのまま追記するだけでよい**

**プレースホルダー解決**
- スニペット内で`{name}`形式の変数を使う場合、3MFヘッダー（`; HEADER_BLOCK_START`ブロック）の値を注入前に解決してから書き込む。**未解決のまま生のプレースホルダー文字列をgcodeに書き込んではいけない**（ファームウェアがリテラル文字列として誤解釈し、座標異常やクラッシュを引き起こす既知の不具合パターンがある）
- 未知のプレースホルダーはそのまま残して警告ログを出すに留め、処理を止めない

**MD5サイドカーの再計算（重要・見落としやすい）**
- `.gcode.3mf`内には`Metadata/plate_1.gcode.md5`のようなチェックサムのサイドカーファイルが存在し、ファームウェアはこれでgcodeの整合性を検証する。**注入後はこのMD5を再計算してサイドカーを更新しないと、ファームウェアがファイルを受け付けない可能性がある**
- 注入は常に元ファイルとは別の一時コピー上で行い、元のアーカイブ/ライブラリファイルは一切変更しない

---

## 8. API仕様

```
POST   /api/queue                  3mf/stlアップロード（②③開始）
GET    /api/queue                  キュー一覧
PATCH  /api/queue/reorder          並び替え
GET    /api/queue/:id/thumbnail    サムネイルPNG
GET    /api/queue/:id/model        メッシュJSON（3Dプレビュー用）
GET    /api/queue/:id/filaments    フィラメント一覧
PATCH  /api/queue/:id/filaments    フィラメント変更・ams_mapping確定（④→⑤遷移）
POST   /api/queue/:id/abort        印刷中止
POST   /api/queue/:id/retry        再試行
DELETE /api/queue/:id              未実行ジョブ削除

GET    /api/projects               プロジェクト一覧（ETA集計込み）
POST   /api/projects               プロジェクト作成
PATCH  /api/projects/:id           color_consistency_policy等の変更

GET    /api/pending-actions        未解決の対応待ち一覧
POST   /api/pending-actions/:id/resolve  対応完了を報告

GET    /api/printer/status         現在の進捗・温度・ETA
GET    /api/printer/snapshot       カメラ最新フレーム
GET    /api/ams/status             AMS/BMCU実装填状況

GET    /api/stocker/status         ストッカー残数
POST   /api/stocker/refill         残数リセット（人間が物理補充後に実行）

GET    /events                     SSE（状態変化をリアルタイムpush）
```

---

## 9. MQTT通信仕様（対A1 mini）

印刷開始コマンド例：

```json
{
  "print": {
    "sequence_id": "0",
    "command": "project_file",
    "param": "Metadata/plate_1.gcode",
    "url": "ftp:///cache/{job_id}.gcode.3mf",
    "use_ams": true,
    "ams_mapping": [-1, -1, 0, -1],
    "bed_leveling": true,
    "flow_cali": true,
    "vibration_cali": true
  }
}
```

- `ams_mapping` は必ず4要素固定（AMSスロット0〜3に対応）。5要素にすると外部スプール扱いに化ける既知の罠あり
- 中止：`stop`コマンド送信→ノズル位置不定になるため、直後に専用「排出専用ジョブ」（ホーミング＋交換シーケンスのみのgcode.3mf）を通常の印刷ジョブとして送信し、機構を安全な状態に戻す
- 進捗監視：`gcode_state`（RUNNING/FINISH/FAILED/PAUSE）、`mc_remaining_time`（分単位の残り時間、リアルタイム更新）、HMSエラーコード
- ⚠️ HMS一時停止状態から「別AMSスロットを選んで再開」するコマンドの正確な仕様は未検証（16章参照）

---

## 10. 完了時刻（ETA）計算

```ts
function calcEta(queue: Job[], printerStatus: PrinterStatus) {
  const now = Date.now()
  let cursor = now

  if (printerStatus.gcode_state === 'RUNNING') {
    cursor += printerStatus.mc_remaining_time * 60_000  // MQTTのリアルタイム値
    cursor += SWAP_DURATION_MS
  }

  const plateEtas: Record<number, number> = {}
  for (const job of queue.filter(j => j.status === 'queued')) {
    cursor += job.estimated_seconds * 1000  // スライス時の静的見積もり
    plateEtas[job.id] = cursor
    cursor += SWAP_DURATION_MS
  }
  return { projectEta: cursor, plateEtas }
}
```

- 印刷中ジョブ：MQTTの`mc_remaining_time`（実進行を反映、精度が高い）
- 未着手ジョブ：アップロード時にgcodeヘッダーから抽出した静的見積もり
- `SWAP_DURATION_MS`：交換シーケンスの実測所要時間（固定値、要キャリブレーション）
- `project_id`でジョブをグルーピングすれば、プロジェクト単位の完了予定時刻もそのまま算出できる

---

## 11. ストッカー（プレート枚数）管理

```ts
async function onSwapExecuted() {
  await db.run(`UPDATE stocker_state SET remaining = remaining - 1`)
}
```

- スワップが発生するたび（成功完了時・異常終了からの強制排出時の両方）に残数を1減らす
- セッション開始時にビルドプレートが既に1枚セットされている前提のため、その1枚はストッカー消費にカウントしない
- `capacity`はハードウェア固有値として設定ファイルで保持。参考値：公式Swap Systems社のSwapmod Kitは最大10枚を推奨上限としている（Niiさん版が同一容量とは限らないため実機確認は別途必要）
- ストッカー残数0は`pending_actions`に`type: stocker_refill, severity: blocking_queue`として登録する（13章参照）

---

## 12. プロジェクト管理

プレートは任意で1つのプロジェクトに所属できる（`jobs.project_id`）。プロジェクトは「色の一貫性をどこまで保証するか」というポリシーを持つ。

```sql
-- color_consistency_policy: 'strict' | 'propagate'
```

- **strict**：あるプレートでフィラメント代替（色違い）が発生した場合、同プロジェクトの後続プレートは自動進行を止め、`pending_actions(type: color_decision)`を登録して人間の判断を仰ぐ
- **propagate**：代替色を同プロジェクトの後続queuedプレート全部に自動適用し、完走させる

```ts
async function onPlateFinishedWithSubstitution(job: Job) {
  if (!job.project_id) return
  const project = await getProject(job.project_id)

  if (project.color_consistency_policy === 'propagate') {
    await applySubstitutionToRemainingPlates(job.project_id, job.substituted_slot)
    await notify(`ℹ️ ${project.name}: 残りのプレートも代替色(${job.substituted_color})で続行します`)
  } else {
    await createPendingAction({
      type: 'color_decision',
      job_id: job.id,
      project_id: job.project_id,
      severity: 'blocking_job',
      message: `${project.name}: 色が代替されました。残りを同じ代替色で続けますか？元の色が補充されるまで待ちますか？`,
    })
  }
}
```

**ディスパッチはプロジェクト単位でブロックを判定する**。あるプロジェクトが`color_decision`待ちで止まっていても、他のプロジェクトのキューは進行を続ける。

```ts
async function dispatchNext() {
  const stocker = await getStockerState()
  if (stocker.remaining <= 0) {
    await createPendingAction({ type: 'stocker_refill', severity: 'blocking_queue', message: 'ストッカーが空です' })
    return
  }

  const candidates = await db.all(`SELECT * FROM jobs WHERE status = 'queued' ORDER BY position ASC`)
  for (const job of candidates) {
    const blocked = job.project_id && await hasUnresolvedPendingAction(job.project_id, 'color_decision')
    if (blocked) continue // このプロジェクトは止まっているが、他は飛ばして続行
    return dispatch(job)
  }
}
```

ETA計算（10章）も`project_id`でグルーピングすれば、プロジェクト単位の完了予定がそのまま得られる。

---

## 13. ユーザーアクション要求（pending_actions統一モデル）

システム内で人間の判断・操作待ちが発生するケースを共通テーブルに集約する。

| type | 発生タイミング | ブロック範囲 | 物理操作要否 |
|---|---|---|---|
| filament_confirm | アップロード後のAMSマッピング確定待ち | そのジョブのみ | 不要 |
| stocker_refill | ストッカー残数0 | キュー全体 | 必要 |
| retry_decision | 印刷失敗/中止検知後 | そのジョブ以降 | 場合による |
| filament_runout | フィラメント切れ（自動解決不可時） | そのジョブ | 必要 |
| color_decision | プロジェクトのstrictポリシーで代替色発生 | そのプロジェクト | 不要 |
| mechanical_check | 機構不具合の疑い | 場合による | 必要 |

**自動解決できるものは自動解決し、ズレがある時だけ人間を呼ぶ**方針とする：
- `filament_confirm`：AMS実装填状況とgcode側の要求が完全一致していれば`severity: advisory`として自動でqueued化してよい。不一致時のみ`blocking_job`に格上げ
- `retry_decision`：機構保護のため常に人間判断とする（自動retryループは組まない）
- `filament_runout`：14章の段階的解決チェーンに従う。最終的にどうしても解決できない時のみここに到達する

**通知（Webhookフック）**

```ts
async function notifyPendingAction(action: PendingAction) {
  const embed = {
    title: actionTitle(action.type),
    description: action.message,
    image: action.snapshot_path ? { url: toPublicUrl(action.snapshot_path) } : undefined,
    url: `${BASE_URL}/queue/${action.job_id ?? ''}`, // ディープリンク
  }
  await webhook.send({ embeds: [embed] })
}
```

カメラスナップショットを通知に直接添付し、該当ジョブ画面へのディープリンクを必ず含める。

**エスカレーション（再通知）**

```ts
async function checkStalePendingActions() {
  const stale = await db.all(`
    SELECT * FROM pending_actions
    WHERE resolved_at IS NULL AND severity = 'blocking_queue'
      AND notified_at < datetime('now', '-30 minutes')
  `)
  for (const action of stale) {
    await notifyPendingAction(action)
    await db.run(`UPDATE pending_actions SET notified_at = datetime('now') WHERE id = ?`, action.id)
  }
}
```

`blocking_queue`（全体停止）は定期的に再通知する。`blocking_job`（他は進行中）は緊急性が低いため再通知間隔を長くするか省略してよい。

**Webアプリ表現**：個別画面に状態を埋め込むのではなく、ヘッダー直下に未解決`pending_actions`を集約した「対応待ち」バナーを1箇所持つ（16章）。

---

## 14. フィラメント切れの段階的解決

`system_settings.filament_runout_policy` で、自動解決をどこまで許容するかを1値で制御する。

```
Tier 0: ファームウェア標準機能（AMS Filament Backup）
         → 同一プリセット・同一色のスロットを事前ペアリングしておけば、
           印刷を止めずに自動切替（ファームウェア任せ、自前実装不要）
Tier 1: same_color_only（自前検知）
         → ペアリングが無い/対象外の場合、同タイプ・同色の別スロットがあれば切替
Tier 2: allow_material_match（最終手段）
         → 同タイプなら色違いでも強制続行（PLA同士・PETG同士は接着可能という前提）
         → 必ず advisory通知 ＋ substituted_color フラグを立てる
Tier 3: manual
         → 上記が尽きた、またはポリシーで無効化されている場合のみ pending_actions に登録
```

```ts
async function onFilamentRunout(jobId: number, slotIndex: number) {
  const policy = await getEffectivePolicy(jobId) // ジョブ個別設定 ?? システム全体デフォルト
  if (policy === 'manual') {
    await createPendingAction({ type: 'filament_runout', job_id: jobId, severity: 'blocking_job' })
    return
  }

  const ams = await getAmsStatus()
  const runout = ams.trays[slotIndex]
  const candidates = ams.trays.filter(t => t.index !== slotIndex && t.remaining_g > MIN_THRESHOLD_G)

  const match = policy === 'same_color_only'
    ? candidates.find(t => t.type === runout.type && t.color === runout.color)
    : candidates.filter(t => t.type === runout.type).sort((a, b) => b.remaining_g - a.remaining_g)[0]

  if (!match) {
    await createPendingAction({ type: 'filament_runout', job_id: jobId, severity: 'blocking_job', message: '代替フィラメントが見つかりません' })
    return
  }

  await resumeWithAlternateSlot(jobId, match.index) // ⚠️要検証：再開コマンドの正確な仕様（16章）

  if (match.color !== runout.color) {
    await db.run(`UPDATE jobs SET substituted_slot = ?, substituted_color = ? WHERE id = ?`, match.index, match.color, jobId)
    const job = await getJob(jobId)
    await onPlateFinishedWithSubstitution(job) // 12章：プロジェクトのポリシーに従う
  }

  await notify(`ℹ️ スロット${slotIndex}切れ→スロット${match.index}(${match.color})へ自動切替`)
}
```

**見落としがちな後工程**：色が代替された場合、完了通知（「✅完了」）に必ず反映させる。「✅ plate_03 完了（一部フィラメントが自動切替されました、確認推奨）」のように、サイレントに色が変わったことに後から気づく事故を防ぐ。

---

## 15. 通知仕様

- LINE Notifyはサービス終了済み（2025年3月31日）のため使用不可
- 個人利用の通知先として Discord Webhook または Slack Incoming Webhook を第一候補とする（単一URLへのPOSTのみで完結し実装コストが低い）
- LINEを使いたい場合はLINE Messaging API（公式アカウント作成＋チャネルアクセストークン発行が必要、無料枠は月200通）
- 通知トリガー：`job_finished` / `job_failed` / `waiting_for_refill` / `pending_actions`登録時（13章） / タイムアウト検知

---

## 16. MQTTフロントエンド仕様（ゲートウェイパターン）

自前Mosquitto（コントローラホスト上）のトピック設計：

```
printfarm/queue                       # retained: キュー全体のスナップショット
printfarm/queue/{job_id}/status       # retained: 個別ジョブの状態
printfarm/current/progress            # retained: progress%, eta, layer
printfarm/event                       # 非retain: job_started/finished/failed等
```

- `queue`系・`current/progress`はretain=trueとし、IoTデバイス起動直後に最新状態を即座に受け取れるようにする
- `event`は非retain（一過性のトリガー、通知送信のフックとして利用）
- IoTデバイス（M5Stack等）はこの自前ブローカーのみを購読し、A1 mini本体には接続しない

---

## 17. Webアプリ仕様

- 技術スタック：Bun + Hono（バックエンド）、サーバーレンダリング + htmx + SSE（フロントエンド、Reactは不採用）、Three.js（3Dプレビュー、CDN読込）
- 認証：最低限の固定トークン認証（外部アクセスを想定する場合は必須）

画面構成：
- ヘッダー直下：**対応待ちバナー**（未解決`pending_actions`を集約表示、ジョブ/プロジェクトへのリンク付き）
- ヘッダー：現在印刷中ジョブのライブスナップショット＋進捗バー＋ETA
- メイン：キュー一覧カード（サムネ・ステータスバッジ・試行回数・所属プロジェクト表示）
- カードクリックで3Dプレビューモーダル（メッシュ＋フィラメント色を反映、スロット変更UIから即時再着色）
- フィラメント確認・変更UI（スロットごとの色スウォッチ＋AMS実装填状況からの選択ドロップダウン）
- プロジェクト一覧画面（color_consistency_policy設定、所属プレートの進捗・全体ETA）
- ストッカー残数表示（常時ヘッダーに表示）
- 各カードに中止／リトライ／削除ボタン

```
⚠️ 対応待ち (2)
┌─────────────────────────────────┐
│ 🪧 ストッカーが空です            │
│    [補充完了を報告]              │
├─────────────────────────────────┤
│ ❌ plate_03.gcode.3mf が失敗     │
│    [スナップショットを見る] [リトライ] [削除] │
└─────────────────────────────────┘
```

> 代替案：bambuddyは`3D/3dmodel.model`のメッシュ再構築ではなく、実際のG-codeツールパスをAGPL-3.0互換の外部ビューア（PrettyGCode系）でレンダリングする方式を採用している。実際の色変化・実際の積層順がそのまま見えるため、フィラメント確認の精度という観点ではメッシュ＋paint_color方式より優れている可能性がある。実装コストとのトレードオフとして検討の余地あり。

---

## 18. 異常系の自動化方針（竹レベル）

- 失敗検知：自動中止＋排出（機構を安全な状態に戻す）までは自動化
- リトライ：人間の確認を経てから実行（自動retryループは組まない。失敗プリントの残留物が機構を詰まらせるリスクがあるため）
- リトライ上限：`attempts`に上限を設け、超過時はキューを停止して通知のみ
- フィラメント切れ：14章の段階的解決チェーンに従う

---

## 19. 未解決・要検証事項

- [ ] LAN Only + Developer Modeでの実機MQTTコマンド一覧の動作確認
- [x] 既存OSS（`maziggy/bambuddy`）のソースコード調査 → SwapMod相当の機能が既に存在することを確認。注入位置・MD5サイドカー再計算・プレースホルダー解決の方針を反映済み（7章）。Virtual Printer実装・テスト構成も調査済み（20章）
- [ ] `SWAP_DURATION_MS`の実測キャリブレーション
- [ ] ストッカー`capacity`の実機確認（参考値：Swap Systems公式キットは10枚推奨上限）
- [ ] ヘッドレススライスパイプライン（OrcaSlicer CLI連携）の実装検証
- [ ] 排出専用ジョブ（ホーミング＋交換シーケンスのみのgcode.3mf）の事前作成
- [ ] 3MFの`.gcode.md5`サイドカー形式の実機確認（再計算アルゴリズムの特定）
- [ ] 3Dプレビューのメッシュ方式 vs G-codeツールパス方式の比較検討
- [ ] HMS一時停止状態から「別AMSスロットを選んで再開」するMQTTコマンドの正確な仕様確認
- [ ] AMS Filament Backup（ファームウェア標準機能）の事前ペアリング設定方法の確認
- [x] A1系のFTPS `PROT C`（平文）フォールバック挙動の実機確認 → **実測(2026-07-02): `PROT P → 200` が受理され、データチャネルも P のまま成立（この個体/FWではフォールバック不発生）**。追加発見（FTPSセッションスロットは実質1・QUITで即時解放・無断切断は1〜3分ブロック）は `docs/bambu-protocol-notes.md` の実機実測ノート参照
- [ ] MQTT切断タイミングと印刷完了見落とし（取りこぼし）に対する再同期ロジックの設計

---

## 20. printer-stub仕様（実機検証前のモック環境）

### 20.1 目的とスコープ

実機検証の前段階として、A1 miniをモックしたスタブ環境を用意する。プリント速度を任意倍速化し、フィラメント残量を自由に設定し、障害を意図的に注入できることで、14章・18章のロジックを実機を消耗せずに検証する。

工学的な故障モード（ノズル詰まり、温度異常等）のシミュレーションはスコープ外とする。目的は物理現象の再現ではなく、**オーケストレーターが異常系を正しく検知し、正しい`pending_actions`に振り分けられるかの検証**であるため、以下の3区分への抽象化で十分とする。

### 20.2 アーキテクチャ：プロトコル層でモックする

MQTTだけでは不十分。ディスパッチ（⑥）は「FTPSでファイル送信→MQTTで印刷開始」の2段階処理のため、**MQTT + FTPSの両方**をモックする。カメラ/スナップショットは固定画像を返すだけの簡易スタブで足りる。

```
テストランナー
   ├─ オーケストレーター（本物のコード、接続先だけスタブに向ける）
   └─ printer-stub（別プロセス、Docker Composeのsidecar）
        ├─ MQTT broker (TLS) … 仮想プリンターstate machine
        ├─ FTPS server (implicit, port 990)
        ├─ snapshot endpoint … 固定画像を返すだけ
        ├─ __control API (HTTP) … テストランナー専用の裏口
        └─ __diagnostics API (HTTP) … 接続疎通チェック（20.6参照）
```

> 既存OSS（`maziggy/bambuddy`）の `backend/app/services/virtual_printer/`（MQTTサーバー・FTPSサーバー・SSDP discoveryを自前実装、PREPARE→IDLEのstate machine）が、責務としてほぼ同じものを実装済み。実装前に一度参照する価値が高い。

### 20.3 仮想プリンターのstate machine

```
IDLE → (FTPS受信) → (MQTT project_file受信) → RUNNING（高速カウントダウン） → FINISH / FAILED
```

```ts
let speedFactor = 1000 // __control APIで変更可能

function startSimulatedPrint(job) {
  let remaining = job.initialRemainingMinutes ?? 10
  const interval = setInterval(() => {
    remaining -= 1
    publishStatus({ gcode_state: 'RUNNING', mc_remaining_time: remaining })
    if (remaining <= 0) {
      clearInterval(interval)
      finishPrint(job)
    }
  }, (60_000 / speedFactor))
}
```

### 20.4 フィラメント残量の任意設定

```
POST /__control/ams/:slot   { remaining_g, color, type }
```

オーケストレーターは通常通りMQTTの`ams`レポートを購読するだけで、スタブ内部の値がそのまま流れる。14章のTier 1/Tier 2を、実フィラメントを消費せずに検証できる。

### 20.5 障害分類とfault injection

| 区分 | シミュレーション方法 | 想定するテスト対象 |
|---|---|---|
| プリンター故障 | `gcode_state: FAILED`＋HMSエラーコードを即時publish | retry_decision pending_action、通知 |
| swapシステム故障 | プリンターのMQTTには現れない（Niiさんmodはファームウェアの関知するところではない）。**次のディスパッチを強制的に即FAILEDにする**ことで間接的に再現 | ストッカー消費とのズレ、連鎖的な失敗の検知 |
| 一時的な障害 | MQTT接続の切断/FTPSアップロードの途中打ち切りを指定タイミングで発生 | 再接続・リトライ処理の堅牢性 |

```
POST /__control/fault
{ "category": "printer" | "swap" | "transient", "timing": "now" | "next_print" | "on_state_transition:FINISH" }
```

**追加すべき重要なfaultタイミング**：bambuddyの実際の不具合事例として、印刷完了（`RUNNING → FINISH`）の瞬間にMQTT接続が切断され、完了イベントを取りこぼしたまま気づかれない、という障害が報告されている。これは単純な「切断後に再接続できるか」ではなく、「**再接続後に取りこぼした状態をどう拾い直すか**」という別の検証軸を要求する。`timing: "on_state_transition:FINISH"`はこの再現専用に用意し、オーケストレーター側に状態の再同期ロジック（再接続時に必ず最新statusを1回フルポーリングする等）が必要かどうかを判断する材料にする。

### 20.6 プロトコル再現上の注意点

- **A1系のFTPS PROT Cフォールバック**：A1/A1 miniはデータチャネル暗号化（`PROT P`）の要求に対し平文（`PROT C`）にフォールバックする実機の癖が報告されている。implicit FTPSで固定実装すると実機で詰まる可能性があるため、スタブ側でもこのフォールバック挙動を再現し、オーケストレーターのFTPSクライアントが両方のケースに対応できるか検証する
- **MQTT keepalive**：CONNECTパケットで negotiate されたkeepalive値を無視してハードコードされたタイムアウトで切断する、という実装ミスが他OSSで実際に発生した前例がある。スタブ実装時も、クライアント側が指定したkeepaliveを正しく尊重するか確認する

### 20.7 診断エンドポイント

実機検証フェーズへの移行をスムーズにするため、スタブ・実機どちらに対しても使える診断APIを用意する。

```
GET /api/diagnostics        （CLI版: bun run diag）
→ {
    host,
    mqtt_reachable, ftps_reachable,      // 素のTCP到達性（MQTT/FTPS ポート）
    mqtt_auth_ok, report_received,       // mqtts接続（bblp+アクセスコード）→ pushall → report受信
    ftps_auth_ok,                        // implicit FTPS ログイン
    prot_mode,                           // "P" | "C" | "none"（19章のPROT Cフォールバック実測）
    prot_detail,                         // PROTプローブの応答コードtrace
    sample_report,                       // 受信reportのprintブロック生JSON（実機調査のエビデンス）
    errors                               // 失敗した検査ごとの理由
  }
```

各検査は個別に時間制限を持ち、失敗しても例外を投げず構造化して返す（「失敗も正常な結果」）。
`developer_mode_enabled` はMQTTからは確実に判定できないため、書き込み系コマンドの実挙動に委ね、
診断では扱わない。アクセスコードの妥当性は `mqtt_auth_ok` / `ftps_auth_ok`（実際の認証成否）で判定する。
実装は `src/orchestrator/diagnostics.ts`（I/Oアダプタ層。coreは触らない）。**アクセスコードは
結果にもログにも出さない**。スタブ・実機の両方で同じ診断ロジックが通ることを確認できれば、
切り替え時の不具合切り分けが速くなる。

### 20.8 テスト構成（参考：bambuddyの構成）

- バックエンド：`pytest`相当（本プロジェクトではBun標準のテストランナー）でunit/integrationを分離
- FTPSモックに対する障害注入を含む網羅的なテストスイート（接続・アップロード・ダウンロード・モデル固有挙動・障害注入の5カテゴリ）を目指す
- 通知まわりの副作用処理（スナップショット取得等）には必ずタイムアウトガードを入れる。副作用が詰まって完了通知自体が出ない、という実例が他OSSで報告されている
