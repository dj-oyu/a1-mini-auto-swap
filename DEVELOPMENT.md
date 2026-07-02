# DEVELOPMENT

人間の開発者向けの実務ガイド。プロジェクトの背景・アーキテクチャは [`README.md`](README.md)、
仕様の一次情報は [`multiplate-auto-print-spec.md`](multiplate-auto-print-spec.md)、
AIエージェント向けの規約は [`CLAUDE.md`](CLAUDE.md)（本書と重複する内容はそちらが正）。

## セットアップ

要件: [Bun](https://bun.sh)（Docker は使わない — 全て Bun プロセスで完結）。
実機へのFTPSアップロードには **`curl`** が必要（Windows 10+ / 全 Linux コントローラホストに標準搭載。
理由は下記「実機FTPSと curl 依存」）。

```bash
bun install
bun run certs        # 初回のみ: スタブ用の自己署名証明書を certs/ に生成
```

環境変数は `.env.example` を `.env`（gitignore 済み）にコピーして設定。
**公開リポジトリなので、環境固有情報（IP・アクセスコード・SSID・webhook URL）は絶対にコミットしない。**

## コマンド

| コマンド | 内容 |
|---|---|
| `bun run stub` | 仮想プリンター起動（MQTT/TLS :8883、implicit FTPS :990、`__control` API :3001） |
| `bun run dev:ui` | UI開発ハーネス（シード済み in-memory DB で API+UI を配信。実機・ブローカー不要） |
| `bun run start` | 本番オーケストレーター（`.env` の接続先プリンター/Mosquitto が必要） |
| `bun run diag` | 疎通診断（spec 20.7）。`.env` の `PRINTER_*`（無ければ `STUB_*`）宛にMQTT/FTPS到達性・認証・PROTモードを検査し表を出力。全pass=exit 0 / 失敗=exit 1 |
| `bun test` | 全テスト（`test/phase2` の意図的RED も含む） |
| `bun run test:ci` | **CIと同じ緑ゲート**（`test/stub` `test/verify` `test/db` `test/orchestrator` `test/core` `test/injection` `test/api` `test/dev`） |
| `bun run test:e2e` | Playwright ブラウザE2E（28本、dev harness を自動起動）。初回は `bunx playwright install chromium` |
| `bun run typecheck` | `tsc --noEmit`（strict + noUncheckedIndexedAccess ほか） |

ポート 990/8883 が特権ポートの環境では、`.env` で `STUB_FTPS_PORT=9990` 等に逃がす。

## レイヤ規約（違反するとレビューで差し戻し）

依存は内側（core）へ一方向。**新しい実装を書くときは、まず「どの層か」を決める。**

- `src/core/` — 純粋ドメイン。**I/O 禁止・外部ライブラリ禁止・node builtins 禁止**。
  時刻は `Clock` port、通知は `Notifier` port、永続化は `QueueStore` port 経由
- ドメインルール（ディスパッチ順序・ETA・AMS一致・runout tier・色ポリシー・エスカレーション）は
  core に置き、api/orchestrator に漏らさない
- 外部 I/O（MQTT/FTPS/HTTP/webhook/SQLite）は必ず port の adapter として実装
- 外部入力の検証: HTTP/MQTT 境界は zod（`src/api/`・`src/orchestrator/` のスキーマ）、
  core 内の検証は純関数（例: `core/ams-mapping.ts`、`core/color.ts`）
- プロトコル名の突き合わせは `src/protocol/` と `docs/bambu-protocol-notes.md` に隔離

## ワークフロー

`main` は保護済み（必須チェック `test`、strict、PR必須）。**直接 push しない。**

1. `main` からブランチを切る（slice 単位 — フェーズ丸ごとの巨大PRにしない）
2. **完了条件を先に機械判定可能にする**: 触れる仕様があれば `invariants.yaml` の INV /
   `scenarios/` に翻訳してから着手
3. **red-green**: 失敗するテストを先に書き、*正しい理由で*落ちることを確認してから実装
4. `bun run typecheck` + `bun run test:ci` 緑（UIを触ったら `test:e2e` も）
5. PR 作成 → CI（`test` + `e2e`）緑 → squash-merge

### PR の Definition of Done

typecheck 緑 / `test:ci` 緑 / 新規テストが意味を持つ（存在チェックだけの弱assertにしない）/
触れた INV・scenario を更新 / docs 更新 / 秘密・環境固有情報なし。

## テストの構造

| 場所 | 役割 |
|---|---|
| `test/{core,db,injection,...}` | ユニット/統合。CI対象。INVに対応するテストは `// INV-XXX-NN` タグを付ける |
| `test/stub` | 仮想プリンター自体のテスト（MQTT/FTPSプロトコル準拠含む） |
| `test/verify` | シナリオランナー + **INVトレーサビリティのメタテスト**（全INVがどこかで参照されているかをCIで強制） |
| `test/phase2/` | **未実装フェーズの意図的REDテスト置き場**（CI対象外）。実装して緑にしたら CI 対象ディレクトリへ移す |
| `test/e2e/*.e2e.ts` | Playwright。`.spec.ts` ではなく `.e2e.ts`（`bun test` に拾わせないため）。別ワークフロー `e2e.yml` |
| `scenarios/*.yaml` | シナリオDSL（受け入れテスト）。文法は [`scenarios/README.md`](scenarios/README.md) が契約 |

### 決定論の掟

- スタブの state machine は内部タイマーを持たない。テストは `tick()` / `forceFinish()` /
  `__control` で駆動し、**wall-clock 待ち（固定sleep）を書かない**
- 時刻依存のロジックは `Clock` port を注入してテストする（例: `test/core/escalation.test.ts`）
- DBは `:memory:`、ネットワークを使う統合テストは port 0（OS任せ）でポート競合を避ける

### 不変条件とシナリオを増やすとき

1. 仕様の記述を `invariants.yaml` に INV として追加（`layer: machine` を優先。`ai` は最小限）
2. それを検証するテスト or シナリオを書き、`// INV-XXX-NN` タグで紐付ける
   （タグがないと `test/verify/inv-traceability.test.ts` が落ちる）
3. シナリオで使う DSL 語彙を増やす場合は `scenarios/README.md` を必ず更新

## 実機FTPSと curl 依存

プリンターへの `.gcode.3mf` アップロードは **システムの `curl` バイナリ**を経由する
（`src/orchestrator/ftps-curl.ts`）。理由は実機FTPSの2つの癖（`docs/bambu-protocol-notes.md`
実機実測ノート）:

1. 実機はデータチャネルに **TLS + 正常な close_notify** を要求して STOR を完了する。
2. **Bun の TLS 実装は close_notify を送出しない**（生レコード観測で確認）。node-forge は
   TLS1.2+GCM 非対応で代替不可。

curl（OpenSSL/schannel）はクリーンな TLS シャットダウンを行い、実機で `226` を得られる唯一の
クライアントだった。オーケストレーターは転送を引き続き管理する: 進捗は curl の stdin へ流す
バイト数、中止はプロセス kill、将来の再開は `curl -C -`。アクセスコードは argv/env に出さず
**mode 0600 の一時設定ファイル（`curl -K`）**で渡し、使用後に削除する。全 FTPS 操作は
プリンターの単一セッションスロットを共有するため直列化される（`runSerialized`）。

`curl` が PATH に無い場合、アップロードは `CurlNotFoundError`（「install curl」明示）で失敗する。
関連ユニット/統合テストは curl が無い環境では自動スキップされる。

## デプロイ（コントローラホスト）

arm64 Linux 上で Bun プロセスとして常駐させる（Docker不使用）。`.env` を配置して
`bun run start`（`curl` が PATH にあること）。systemd 化・自動再起動の整備は Phase 8 の作業項目。

## トラブルシュート

- **スタブ起動時に証明書エラー** → `bun run certs` を実行したか確認（`certs/` に生成）
- **FTPS 990 / MQTT 8883 で権限エラー** → 特権ポート。`.env` で `STUB_FTPS_PORT` 等を高位ポートへ
- **`bun run test:e2e` が起動しない** → `bunx playwright install chromium` 済みか確認
- **`bun test` で RED がある** → `test/phase2/` の意図的REDは正常（CIゲートは `test:ci`）
- **実機接続の切り分け** → スタブと実機の両方に使える診断（spec 20.7）を使う。`bun run diag`（CLI、表出力）または `GET /api/diagnostics`（JSON）で、MQTT/FTPS到達性・MQTT認証・reportの受信・FTPSログイン・PROTモード（P/C/none）を一括チェックできる。実機移行時はまずこれを緑にする
