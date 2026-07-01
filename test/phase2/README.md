# test/phase2 — 未実装フェーズの RED テスト（red-green ドライバ）

ここには**まだ実装していない機能に対する、意図的に失敗する（RED）テスト**を置く。
CI（`bun run test:ci` = `bun test test/stub`）はこのディレクトリを**実行しない**ので、
グリーンゲートは保たれる。ローカルで `bun test`（全体）を回すと RED が見えて、
次に実装すべき対象がわかる。

実装が完了したら、そのテストファイルを `test/stub/` へ移動して CI 対象に含める
（＝ red → green の完了）。

## 現在の RED

（なし）

- Phase 2 implicit FTPS は **実装完了**。緑になったので `test/stub/ftps-server.test.ts`
  へ移動済み（CI 対象）。

次フェーズの RED テストをここに置く運用は継続する。
