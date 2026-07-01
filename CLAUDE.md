# CLAUDE.md

Claude Code が本リポジトリで作業する際の指針。**各セッションの最初に読むこと。**

## これは何か

Bambu Lab A1 mini + BMCU 370C で自動ビルドプレート交換modを使い、複数プレートを連続印刷する
**セルフホスト・ノークラウド**の管理システム。常時起動の **arm64 Linux「コントローラホスト」**
にデプロイし、機器間は **Tailscale** で接続する。

- 仕様: `multiplate-auto-print-spec.md`
- 開発計画 & AI自動verify設計: `dev-plan-and-ai-verify.md`
- 不変条件: `invariants.yaml` ／ シナリオ: `scenarios/`
- プロトコル実装ノート: `docs/bambu-protocol-notes.md` ／ Tab5フロント: `docs/m5stack-tab5-frontend-research.md`

## スタック & コマンド

Bun + Hono + TypeScript(strict)。**Docker は使わない**（全て Bun プロセスで完結）。

```bash
bun install
bun run stub          # printer-stub 起動（:8883 MQTT/TLS, :3001 control/HTTP）
bun test              # 全テスト（test/phase2 の RED も含む）
bun run test:ci       # = bun test test/stub（グリーンゲート）
bun run typecheck     # tsc --noEmit
```

`test/phase2/` には**未実装フェーズの RED テスト**を置く（CI 対象外）。実装して緑にしたら
`test/stub/` へ移す。

## リポジトリ / CI / ブランチ保護

- 公開リポジトリ。default branch `main` は**保護済み**：必須チェック `test`、strict（最新必須）、
  PR 必須（承認0＝チェック緑なら self-merge 可）、admin はバイパス可。
- **`main` に直接 push しない。** 必ず ブランチ → PR → CI `test` 緑 → マージ。
- CI: `.github/workflows/ci.yml`（push/PR to main）= `bun install --frozen-lockfile` →
  `typecheck` → `test:ci`。

## 開発ワークフロー（フェーズごと・合意済み）

各フェーズを **slice 単位の PR**（フェーズ丸ごとの巨大PRにしない）で、以下のループで進める：

1. **完了条件を機械判定可能にする** — フェーズの完了条件を `invariants.yaml` の INV と
   scenario/acceptance テストへ翻訳してから着手。**Opus が下書き→人間が承認**（「正解」は人間が
   所有し、AIに自己採点させない）。
2. **テスト作成（RED）** — Sonnet が作成。*正しい理由で* 失敗すること。**Opus がテストの妥当性と
   red の正しさを検証**。
3. **実装（GREEN）** — Sonnet が実装、難所は Opus。**実装者 ≠ テスト作者**。実装者はテストを
   緩めない。テストの不備は `// SUSPECT:` で申告のみ（勝手に書き換えない）。
4. **ローカルテスト** — `typecheck` 緑 ＋ `bun test` 緑。
5. **PR** — 作成。**Opus が PR 時に敵対的レビュー**（弱いassert・false green・抜け）。`/code-review` 併用可。
6. **CI 緑 → main にマージ → 次の slice / フェーズへ。**

**役割分担**：Sonnet = 幅（テスト作成・実装）。Opus = 検証（テスト品質・実装の敵対的レビュー）＋難所の実装。

### PR の Definition of Done
`typecheck` 緑 ／ `test:ci` 緑 ／ 新規テストが意味を持つ ／ 触れた INV・scenario を更新 ／
docs 更新 ／ **秘密・環境固有情報なし**。

## 守るべき規約

- **公開リポジトリ**：環境固有情報（tailnet IP/MagicDNS、アクセスコード、SSID、鍵）や
  ホストの製品名を**絶対にコミットしない**。`.env`（gitignore 済み）＋ `.env.example` で管理。
  ホストは "controller host / コントローラホスト" と呼ぶ（"arm64 Linux" は可）。
- **決定論**：stub の state machine は内部タイマーを持たない。テストは `tick()`/`forceFinish()`/
  `__control` で駆動し、**wall-clock 待ちを書かない**。
- プロトコル名の突き合わせは `topics.ts`/`types.ts`/`docs/bambu-protocol-notes.md` に隔離。

## フェーズ状況

- **完了**: Phase 0、Phase 1（printer-stub）、Phase 2（implicit FTPS 990）、シナリオランナー
  （`src/verify/`）、**Phase 3（コアループ）**:
  - 3a `src/db/`（schema/migrations/typed Repo、invariant CHECK）
  - 3b `src/orchestrator/dispatcher.ts`（キュー state machine / ディスパッチ / project block）
  - 3c `src/orchestrator/`（MQTT/FTPS クライアント + ETA、実stubに対し統合テスト）
  - 3d `src/verify/stub-sut.ts`（DB+dispatcher+VirtualPrinter を束ねる実 `Sut`）→
    **`scenarios/S1,S2` がランナー経由で緑**（= Phase 3 完了条件、達成）。checkInvariant は
    実フック（transition ログ/送信 mapping/通知/ETA計算）で機械判定、未実装 INV は false で明示失敗。
- **次**: 監視ループ（spec ⑦ MQTT status→dispatcher.onFinished/onFailed、`src/orchestrator/monitor.ts`）
  を実装して S1/S2 を「直接 onFinished 呼び」から「MQTT駆動」へ移行。以降 Phase 4（注入）/5（異常系,
  S3–S8）/6（UI）/7（ゲートウェイ, printfarm/* → Tab5）。
