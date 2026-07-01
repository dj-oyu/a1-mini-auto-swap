# test/phase2 — 未実装フェーズの RED テスト（red-green ドライバ）

ここには**まだ実装していない機能に対する、意図的に失敗する（RED）テスト**を置く。
CI（`bun run test:ci` = `bun test test/stub`）はこのディレクトリを**実行しない**ので、
グリーンゲートは保たれる。ローカルで `bun test`（全体）を回すと RED が見えて、
次に実装すべき対象がわかる。

実装が完了したら、そのテストファイルを `test/stub/` へ移動して CI 対象に含める
（＝ red → green の完了）。

## 現在の RED

- `ftps-server.test.ts` — **Phase 2: implicit FTPS（990）**。`src/stub/ftps-server.ts` は
  現在スケルトン（`throw "not implemented: Phase 2 FTPS"`）。仕様は
  `docs/bambu-protocol-notes.md` の FTPS 表（TLS1.2 固定、`bblp`+アクセスコード、
  STOR、**PROT C 受理＝A1 フォールバック**）。実装してこの 7 テストを緑にしたら
  `test/stub/` へ移す。
