# Web UI 開発 引き継ぎドキュメント

このプロジェクトに初めて触れる開発者向け。**あなたのミッションは、既に動いているバックエンド
（HTTP API）の上に、ブラウザ向け Web UI を作ること**です。バックエンドは完成・テスト済みで、
`bun run start` で起動します。ドメインロジックはすべて API/core 側にあります。UI は
「API を叩いて表示・操作する presentation 層」に徹してください。

---

## 0. まず読む順番（30分で全体像）

1. **`CLAUDE.md`**（リポジトリ直下）— 開発方針・アーキテクチャ規約・コマンド。**必読・厳守**。
2. **`multiplate-auto-print-spec.md`** — システム全体仕様。特に **8章（API）**・**13章（対応待ち）**
   ・**17章（Webアプリ要件）**。
3. 本書（UI要件・API・デザイン像）。
4. 参考：`docs/m5stack-tab5-frontend-research.md` — M5Stack Tab5 用のIoTモニタ（別フロント）。
   Web UI とは別物だが、後述の `printfarm/*` イベント契約を共有する。

---

## 1. プロジェクトは何をするものか（1段落）

Bambu Lab A1 mini に「自動ビルドプレート交換mod」を付け、**複数プレートを連続・半無人で印刷する**
自前管理システム。クラウド非依存（LAN/Tailscale内で完結）。プリンターは振動でプレートが滑る等の
不具合があるため、**完全自動ではなく「異常を検知して人間に通知し、人間が物理対応する」半自動運用**が
設計思想の核。UI はこの「人間の対応待ち」を中心に回る。

---

## 2. 開発方針（CLAUDE.md の要点・厳守）

- **技術**: Bun + Hono + TypeScript(strict)。**Docker不使用**。デプロイ先は arm64 Linux の
  「コントローラホスト」、機器間は Tailscale。
- **公開リポジトリ**: 環境固有情報（IP/アクセスコード/webhook URL/SSID）を**コミットしない**。
  `.env`（gitignore済）＋`.env.example` で管理。
- **フロント技術（spec 17）**: **Hono SSR（サーバレンダリングHTML）＋ htmx ＋ SSE**、3Dは
  **Three.js（CDN読込）**。**React は不採用**。軽量・自前ホスト前提。
- **ワークフロー**: `main` は保護。**直push禁止**。branch → テスト（red-green）→ PR →
  CI（`test`ジョブ）が緑 → squash-merge。**slice単位の小さいPR**。
- **ヘキサゴナル**: `src/api`(HTTPアダプタ) / `src/core`(純ドメイン) / `src/orchestrator`(I/O
  アダプタ) / `src/db` / `src/stub`(仮想プリンター) / `src/verify`。UI は `src/api` 側に SSR
  ルート＋`public/`（静的JS/CSS）を足す形。**ドメインロジックを UI に持ち込まない**。
- **テスト**: 決定論的に。`app.request(...)` でサーバ無しにルートを叩ける（既存 `test/api/*` を参照）。

### コマンド
```bash
bun install
bun run start        # オーケストレーター＋API を起動（要：接続先プリンター）
bun run stub         # 仮想プリンター（開発用の擬似A1 mini）
bun test             # 全テスト
bun run test:ci      # CIと同じ緑ゲート
bun run typecheck
```

### UI開発の最短セットアップ（ハードウェア不要）
本番 `bun run start` は実プリンター/ブローカーへ接続しにいく。**UIを素早く回すなら、API だけを
シードDB上で配信する小さな dev サーバを1本書く**のがおすすめ（`src/api/*` の
`createApiApp/createWriteApp/createUploadApp` を in-memory DB にマウントして `Bun.serve`）。
プリンター実機・Mosquitto なしで、キュー/対応待ち/プロジェクトの画面を実データで開発できる。
（この dev harness を作るのも最初のスライス候補。）

---

## 3. バックエンド仕様：あなたが叩く API

`src/main.ts` が `Bun.serve` で以下を配信（`http://<host>:3000`）。**すべて実装済み・テスト済み**。
データ型は `src/core/types.ts`（`JobRow` / `StockerRow` / `PendingActionRow` / `ProjectRow`）。

### 実装済みエンドポイント

| method | path | 返り値 / 説明 |
|---|---|---|
| GET | `/api/queue` | `{ jobs: JobRow[]（position昇順）, stocker: StockerRow|null }` |
| GET | `/api/queue/:id` | `JobRow` / 404 |
| POST | `/api/queue?filename=<name>` | body=生の`.gcode.3mf`バイト → 201 `{ id, filaments }`（キャッシュ保存＋ジョブ作成、status=processing） |
| POST | `/api/queue/:id/retry` | 200 `{ requeued: boolean }`（試行上限超で false・通知のみ） |
| DELETE | `/api/queue/:id` | 204 / 404 / **409（印刷中は削除不可）** |
| GET | `/api/pending-actions` | 未解決 `PendingActionRow[]` |
| POST | `/api/pending-actions/:id/resolve` | 200 `{ ok }` / 404 |
| GET | `/api/projects` | `ProjectRow[]` |
| POST | `/api/projects` | `{ name, color_consistency_policy? }` → 201 `{ id }` |
| PATCH | `/api/projects/:id` | `{ color_consistency_policy: 'strict'|'propagate' }` → 200 |
| GET | `/api/stocker/status` | `StockerRow` / 404 |
| POST | `/api/stocker/refill` | 200（残数=capacity、`stocker_refill` pending も解決） |
| PATCH | `/api/queue/:id/filaments` | `{ ams_mapping:number[4](-1..3), filaments? }` → 200 `JobRow`（processing→queued、`filament_confirm` pending も解決）／ 400 / 404 / **409（processing 以外は確定不可）** |
| GET | `/api/queue/:id/thumbnail` | キャッシュ 3mf 内蔵のプレートPNG（`image/png`）／ 404 |
| GET | `/api/queue/:id/model` | 3mf から抽出したメッシュ `{ positions:number[], indices:number[] }`（Three.jsビューア用）／ 404 |
| GET | `/api/printer/status` | 実測ライブ状態 `{ printing, job_id, percent, remaining_min, gcode_state }`（MQTT `mc_remaining_time`/`mc_percent`） |
| GET | `/events` | **SSE**。全 `NotifyEvent` をブラウザへ push（実装済み） |

### 未実装（spec 8章にあるが未着手＝UI担当が必要に応じて追加）
- `GET /api/queue/:id/filaments`。
- `POST /api/queue/:id/abort`（印刷中止→排出）。
- `PATCH /api/queue/reorder`（並び替え）。
- `GET /api/printer/snapshot`（カメラ最新フレーム）。

> SSE の作り方：バックエンドは変化を `Notifier` port（`src/core/ports.ts`）に emit している
> （`job_finished`/`job_failed`/`waiting_for_refill`/`pending_action`/`filament_switched`/`timeout`）。
> **`SseBroadcaster` を1つ書いて `Notifier` として実装**し、`CompositeNotifier` に足せば、
> 既存の webhook / gateway と同じ1回の `notify()` で SSE にも流れる。`src/orchestrator/
> webhook-notifier.ts` と `gateway.ts` が実装パターンの手本。

### イベント/リアルタイムのデータ契約（参考：Tab5と共有）

retain付き `printfarm/*`（`src/orchestrator/gateway.ts`）が既に流れている。SSE のペイロードも
これに合わせると Tab5 と一貫する。形は `docs/m5stack-tab5-frontend-research.md §5`：
`printfarm/current/progress`（job_id, gcode_state, percent, layer, remaining_min, eta_epoch_ms…）、
`printfarm/queue`（jobs[], stocker）、`printfarm/event`（type, severity, message）。

### UIが必ず理解すべきドメイン概念

- **ジョブの状態遷移**：`processing → queued → printing → success|failed|aborted|waiting_for_refill`。
- **ストッカー（プレート枚数）**：`remaining/capacity`。0 で全体停止（`stocker_refill` pending）。
- **`pending_actions`（対応待ち）＝人間の出番の統一キュー**。type と severity を持つ：
  - type: `filament_confirm` / `stocker_refill` / `retry_decision` / `filament_runout` /
    `color_decision` / `mechanical_check`
  - severity: `blocking_queue`（全体停止）/ `blocking_job`（そのジョブ/PJのみ）/ `advisory`（情報）
  - **これがUXの中心**（spec 13/17：ヘッダー直下の「対応待ちバナー」）。
- **プロジェクト**：`color_consistency_policy = strict|propagate`。フィラメント代替が起きると
  `substituted_color` が立つ。**代替色は必ず可視化**（サイレント変更事故を防ぐ、spec 14）。
- **ETA**（spec 10）：プレート単位・プロジェクト単位の完了予定。印刷中はMQTT実測で更新。

---

## 4. UI 要件（spec 17 の要約）

- ヘッダー直下：**対応待ちバナー**（未解決 `pending_actions` を集約、ジョブ/PJへのディープリンク付き）。
- ヘッダー：現在印刷中ジョブの**ライブスナップショット＋進捗バー＋ETA**、常時ストッカー残数。
- メイン：**キュー一覧カード**（サムネ・ステータスバッジ・試行回数・所属プロジェクト）。
- カードクリック → **3Dプレビューモーダル**（Three.js、メッシュ＋フィラメント色、スロット変更で即再着色）。
- **フィラメント確認・変更UI**（スロットごとの色スウォッチ＋AMS実装填からの選択ドロップダウン）。
- プロジェクト一覧（policy設定、所属プレートの進捗・全体ETA）。
- 各カードに 中止／リトライ／削除。
- 認証：最低限の固定トークン（外部アクセス想定時は必須）。

> spec 17 に代替案あり：3Dプレビューを「メッシュ再構築」でなく実G-codeツールパスを PrettyGCode系
> ビューアでレンダリングする案（実際の色変化・積層順がそのまま見える）。トレードオフとして検討可。

---

## 5. 私がユーザーなら 3Dプリンター管理アプリに求めるデザイン像

（＝「あなたがユーザーだったら」の設計哲学。上の機能要件を"どういう体験にすべきか"の指針。）

**大原則：このUIの最重要の仕事は「今、自分が動く必要があるか？」に部屋の反対側から一目で答えること。**
プリントは数時間かかる。人は放置して別のことをする。だからUIは「見なくていい」状態を作るのが仕事。

1. **一目で安心（glanceability）**：平常時は**穏やかな緑＝全部順調、何もしなくてよい**。
   目立つのは「対応待ち (N)」という単一の数字で、**平常は 0**。ダッシュボードを凝視させない。

2. **アラーム衛生（cry-wolf しない）**：システムは自動解決できるもの（フィラメント切れTier 0–2等）は
   黙って解決する。UIが人間を呼ぶのは**本当に物理対応が要る時だけ**。`blocking_queue`（全体停止）は
   赤く叫び、`advisory` は小さく囁く。severity を視覚階層に厳密にマップする。**赤は「止まれ・今動け」
   専用**にとっておく。

3. **透明性による信頼**：システムが色を代替した／別スロットへ切替えた時は**必ず明示**する。
   「✅ plate_03 完了（一部フィラメントが自動切替。確認推奨）」のように、**後からサイレントに気づく事故を
   絶対に作らない**。自動判断は必ず可視の痕跡を残す。

4. **物理世界が真実、しかも不安定**：プレートは滑る、ストッカーは詰まる。UIは
   (a) カメラスナップショットを1タップで見られ、(b)「物理的に直した」を1タップで報告（補充完了/解決）
   できること。通知からその**対応画面へ直行するディープリンク**を常に持つ。

5. **通知はモバイル起点、管理はデスクトップ**：Discord で ping → タップ → **その対応にちょうど要る
   画面に着地**。スマホでも「解決」操作は完結でき、デスクトップでは 3Dプレビュー/並び替え等リッチに。

6. **キュー投入は低摩擦・視覚的**：ドラッグ&ドロップでアップロード → **投入を確定する前に**3Dプレビューと
   フィラメント色を確認 → AMSマッピングを**色スウォッチで視覚的に**確定。**このconfirmステップが
   ミスを捕まえる最後の砦**なので、テキストでなく色と形で「これで合ってる」と分からせる。

7. **信じて予定を立てられるETA**：プレート単位・プロジェクト単位で「15:40 完了」を、印刷中は実測で更新。
   「あと何%」より「**何時に終わるか**」。

8. **穏やかな色言語**：状態は小さく一貫したパレットで（printing=青 / success=緑 / failed=赤 /
   waiting=琥珀 / advisory=灰）。色で埋め尽くさない。赤は乱発しない。

9. **3Dプレビューは装飾でなく検証のため**：役割は「正しいモデルが正しい色で載っているか」を**投入前に
   確認**させること。スロット変更で**即座に再着色**し、AMSマッピングの取り違えを目で捕まえられること。

10. **自前ホストらしい即応性**：クラウドのスピナー無し、LAN/tailnet で速い。SaaS ではなく
    **自分が所有する家電**のような手触り。

11. **段階的開示（progressive disclosure）**：既定は簡素（キュー＋状態＋対応待ち）。詳細（HMSコード・
    ログ・per-plate ETA内訳・試行回数）は1クリック奥。メイン画面を散らかさない。

### MVPの順序（この順で価値が出る）
1. **キュー一覧＋状態＋ストッカー残数**（GET /api/queue を表示）
2. **対応待ちバナー＋解決アクション**（GET /api/pending-actions, POST …/resolve, /stocker/refill）
3. **`GET /events`（SSE）でライブ更新**（土台。以降すべてが live になる）
4. **現在印刷中ヘッダー＋ETA**
5. **アップロード＋フィラメント確認**（POST /api/queue, PATCH …/filaments を実装）
6. **3Dプレビュー**（GET …/model, Three.js）

---

## 6. 具体的な最初の一歩

1. `CLAUDE.md` と spec 8/13/17 を読む。
2. **dev harness**（API を seed DB で配信する小さな `Bun.serve` 1本）を書いて、実機なしで開発を回す。
3. **`GET /events`（SSE）** を `SseBroadcaster`（`Notifier`実装）として足す。手本は
   `src/orchestrator/webhook-notifier.ts` / `gateway.ts`。
4. Hono SSR ページ（`src/api` にルート、`public/` に htmx/CSS）を `main.ts` に mount。
5. MVP順に、branch → テスト → PR → CI緑 → merge のループで積む。
6. 迷ったら：**「この画面は"今動くべきか"に一目で答えているか？」**を毎回自問する。

（不明点は `multiplate-auto-print-spec.md` が一次情報。実装済みAPIの正確な挙動は `test/api/*` の
テストが読める仕様書になっている。）
