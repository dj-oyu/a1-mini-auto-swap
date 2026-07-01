# src/verify — シナリオランナー（AI-verify ③）

`dev-plan-and-ai-verify.md` の「③実行と判定」。`scenarios/*.yaml`（DSL は
`scenarios/README.md`）をパースし、**system-under-test（SUT）アダプタ**に対して
steps/asserts を実行し、pass/fail を返す。Phase 3 の前提（S1/S2… を機械判定可能にする）。

## 構成

```
types.ts     Scenario / Setup / Step（判別可能ユニオン）/ ExpectEntry
scenario.ts  YAML → Scenario パーサ（parseScenario / loadScenario / parseStep）
sut.ts       Sut インタフェース（アクション＋クエリ＋checkInvariant）
runner.ts    runScenario(scenario, sut) → RunResult（例外を投げず結果で返す）
```

## 設計の要：アダプタで疎結合

ランナーは具体的な対象を知らない。`Sut` インタフェース越しに駆動する：

- **テスト**（現在）：`test/verify/fake-sut.ts` の in-memory フェイク。オーケストレーターが
  無くてもエンジン自体（パース・step 実行・assert・wait タイムアウト・expect 判定）を検証できる。
- **Phase 3**：オーケストレーター＋stub を叩く実アダプタを実装し、同じ S1/S2 を通す。
  DSL・INV は変えずにアダプタだけ差し替わる。

## 実行モデル

- steps を順に実行。最初に失敗した step で停止し `failure` に記録（例外は投げない）。
- 全 step 成功時のみ `expect` の invariant を評価（`layer: ai` の意味判定はここで AI に回す想定）。
- `wait_until` は `Sut` クエリをポーリング（既定 `DEFAULT_WAIT_MS`、`timeout_ms` で上書き）。
- `assert: { invariant: INV-* }` と `expect` は `Sut.checkInvariant(id)` に委譲。実アダプタが
  INV→チェック関数を引く。

## テスト

`bun test test/verify`（CI 対象＝`test:ci`）。パーサは**実 S1/S2 を読んで DSL 妥当性を保証**
するので、シナリオ側の DSL ドリフトも検出できる。
