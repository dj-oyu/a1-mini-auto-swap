# a1-mini-auto-swap

Bambu Lab A1 mini + 自動ビルドプレート交換mod + BMCU 370C で**複数プレートを連続・半無人印刷**するための、セルフホスト・ノークラウドの管理システム。

Self-hosted, cloud-free multi-plate auto-print orchestrator for a Bambu Lab A1 mini with an automatic build-plate swap mod.

## なぜ作ったか

A1 mini に [Niiさんの自動ビルドプレート交換mod](https://makerworld.com/en/models/925870)（kespro / stoked remix 適用）と BMCU 370C（多色）を組み合わせると、プレートを積んで連続印刷できる——が、それを管理するものが存在しない：

- **Bambu Cloud / Handy は使えない**。LAN Only Mode + Developer Mode 前提（書き込み系MQTTコマンドに必須）で、クラウドから切り離して運用する
- プリンターの MQTT/FTPS は**同時接続数が2〜3**しかなく、複数クライアントが直接つなぐ設計は破綻する
- modは振動でプレートが滑る等の既知の不具合があり、**完全無人は現実的でない**

そこで常時起動の**コントローラホスト（arm64 Linux）**上に、キュー管理・ディスパッチ・監視・通知を一手に引き受けるオーケストレーターを置き、機器間は Tailscale で結ぶ。

## 設計思想

1. **半自動**：自動解決できる異常（フィラメント切れの同色切替など）は黙って解決し、物理対応が必要なときだけ人間を呼ぶ。人間の出番は `pending_actions`（対応待ち）という単一のキューに集約される
2. **一目で分かるUI**：最重要の問いは「今、自分が動く必要があるか？」。平常時は緑の「対応待ち 0」、赤は「止まれ・今動け」専用
3. **透明性**：システムが色を代替したら完了通知に必ず明記する。サイレントな自動判断を作らない
4. **接続の一点集約**：プリンターに直接つなぐのはオーケストレーターのみ。ブラウザは HTTP/SSE、IoTディスプレイは自前 Mosquitto の `printfarm/*` を購読する

## 主な機能

- **キュー & ディスパッチ**：`.gcode.3mf` アップロード → フィラメント確認（AMS一致なら自動キュー投入）→ ストッカー残数・プロジェクトブロックを判定して順次印刷 → 完了で自動的に次へ
- **G-code 注入**：交換シーケンスをアップロード済み 3MF に注入し、**MD5 サイドカーを再計算**してから FTPS 送信（ファームウェアの整合性検証対策）
- **監視 & 再同期**：MQTT status のエッジ検出で完了/失敗を拾い、再接続時はフルポーリングで FINISH の取りこぼしを回復
- **フィラメント切れの段階的解決**：同色切替 → 同素材切替（色代替を記録・通知）→ 人間の判断、をポリシーで制御
- **プロジェクト**：複数プレートをまとめ、色一貫性ポリシー（strict / propagate）で代替色発生時の挙動を選べる
- **異常系**：失敗・中止時は stop → **排出専用ジョブ**（ホーミング+交換のみの印刷）で機構を安全な状態に戻す。リトライは常に人間起点
- **Web UI**：SSR + htmx + SSE（Reactなし・ビルドステップなし）。対応待ちバナー、実測ETA付き進捗、3Dプレビュー（Three.js、スロット変更で即再着色）、ドラッグ並び替え、カメラモーダル
- **通知 / IoT**：Discord/Slack Webhook、SSE、自前 Mosquitto への `printfarm/*` retained 再publish（M5Stack Tab5 等の監視ディスプレイ向け）

## ハードウェア / ネットワーク前提

| 項目 | 内容 |
|---|---|
| プリンター | Bambu Lab A1 mini（**LAN Only Mode + Developer Mode 必須**） |
| 多色機構 | BMCU 370C |
| プレート自動化 | Niiさん版 自動ビルドプレート交換mod + remix |
| ホスト | コントローラホスト（常時起動の arm64 Linux） |
| ネットワーク | 同一LAN / Tailscale tailnet |

> ⚠️ 本リポジトリは公開です。IPアドレス・アクセスコード・SSID等の環境固有情報は `.env`（gitignore済み）にのみ置き、コミットしません。`.env.example` を参照してください。

## アーキテクチャ

ヘキサゴナル（ports & adapters）。依存は内側（core）へ一方向。

```
A1 mini (MQTT:8883 / implicit FTPS:990)
   ⇅
オーケストレーター (Bun + Hono)
   ├─ src/protocol/      Bambu ワイヤモデル（topics / messages）
   ├─ src/core/          純粋ドメイン：dispatcher / eta / runout / color-policy / escalation
   │                     （I/O禁止・外部ライブラリ禁止。時刻は Clock port、通知は Notifier port）
   ├─ src/db/            SQLite 永続化（Repo が core の QueueStore を実装）
   ├─ src/orchestrator/  I/O アダプタ：MQTT/FTPS クライアント、monitor、gateway、notifier
   ├─ src/injection/     3MF 展開・G-code注入・MD5 サイドカー
   ├─ src/api/           HTTP API + SSR Web UI（Hono）
   ├─ src/stub/          仮想プリンター（MQTT/TLS + implicit FTPS の実装込みテストダブル）
   └─ src/verify/        シナリオランナー + 不変条件の機械検証
自前 Mosquitto → printfarm/* → IoTディスプレイ（M5Stack Tab5 等）
```

## クイックスタート（実機不要）

```bash
bun install

# ターミナル1: 仮想プリンター（MQTT/TLS :8883, FTPS :990, control API :3001）
bun run certs   # 初回のみ: 自己署名証明書を certs/ に生成
bun run stub

# ターミナル2: シード済みDBでUIだけ動かす開発ハーネス
bun run dev:ui  # → http://localhost:3000
```

実機に向ける場合は `.env.example` を `.env` にコピーして接続先を設定し、`bun run start`。

## 検証機構（このリポジトリの一番面白いところ）

実機は遅く・消耗し・非決定論的なので、**仕様を機械可読な不変条件に落とし、決定論的スタブの上で検証する**：

- **[`invariants.yaml`](invariants.yaml)** — 仕様書の各章を約60個の検証可能な不変条件（INV-XXX-NN）に翻訳。「仕様＝不変条件＝テスト」の三位一体
- **[`scenarios/`](scenarios/)** — 不変条件を破りにいく/守れることを示すシナリオ（YAML DSL）。`src/verify/` のランナーが実DB+実dispatcher+仮想プリンターの上で決定論的に実行
- **スタブは内部タイマーを持たない**。テストは `tick()` / `forceFinish()` / `__control` で駆動し、wall-clock 待ちを書かない
- 全INVがテスト/シナリオから参照されていることをCIのメタテストが強制（未カバーは理由つきで明示）

詳細な思想は [`dev-plan-and-ai-verify.md`](dev-plan-and-ai-verify.md) を参照。

## 状況

Phase 0〜7（足場 / printer-stub / プロトコル境界 / コアループ / 注入 / 異常系 / UI / ゲートウェイ）は実装・テスト済み。**次は Phase 8（実機移行）**で、以下が実機検証待ち：

- `SWAP_DURATION_MS`・ストッカー容量の実測キャリブレーション
- 排出専用ジョブの最小構成 3MF をファームウェアが受理するか
- HMS一時停止からの別スロット再開 MQTT コマンド（現状は警告つき未実装）
- A1 の FTPS `PROT C` フォールバック実機挙動

全リストは [`multiplate-auto-print-spec.md`](multiplate-auto-print-spec.md) 19章。

## ドキュメント

| ファイル | 内容 |
|---|---|
| [`multiplate-auto-print-spec.md`](multiplate-auto-print-spec.md) | システム仕様書（一次情報） |
| [`dev-plan-and-ai-verify.md`](dev-plan-and-ai-verify.md) | 開発計画と AI 活用自動 verify 機構 |
| [`DEVELOPMENT.md`](DEVELOPMENT.md) | 開発者向け：セットアップ・コマンド・規約・テスト |
| [`docs/bambu-protocol-notes.md`](docs/bambu-protocol-notes.md) | Bambu MQTT/FTPS プロトコル実装ノート |
| [`docs/ui-handoff.md`](docs/ui-handoff.md) | Web UI の要件・API・デザイン哲学 |
| [`docs/m5stack-tab5-frontend-research.md`](docs/m5stack-tab5-frontend-research.md) | IoT監視ディスプレイ（Tab5）調査 |
| [`CLAUDE.md`](CLAUDE.md) | AI コーディングエージェント向けの作業指針 |

## ライセンス

[MIT](LICENSE)
