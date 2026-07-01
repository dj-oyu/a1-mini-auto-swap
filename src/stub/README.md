# printer-stub — A1 mini 仮想プリンター（spec 20章）

実機を消耗せずにオーケストレーターと検証機構を回すためのモック。
`maziggy/bambuddy` の `virtual_printer/` を参考に、Bun/TypeScript で再実装。

## Docker は不要

bambuddy や spec の図では Docker Compose の sidecar として描かれているが、**この実装は
Docker を一切必要としない**。すべて Bun プロセス内で完結する：

- MQTT broker（TLS 8883）… `aedes` + `node:tls` をプロセス内で起動（`mqtt-server.ts`）
- HTTP（`__control` / `/api/diagnostics`）… Hono を `Bun.serve` で（`control-api.ts`）
- TLS 証明書 … 初回起動時に system `openssl` で自己署名を自動生成（`tls.ts`）。手動セットアップ無し
- テスト … スタブをプロセス内で直接 new して駆動。コンテナも別プロセスも不要

つまり検証の実行単位は「1個の Bun プロセス」または「テストプロセスに内蔵」であり、
`docker compose up` のような外部依存は無い。

## 構成

```
src/stub/
  types.ts           ドメイン型（GcodeState, Tray, ProjectFileCommand, StatusReport…）
  virtual-printer.ts コア state machine（純ロジック・タイマー無し＝決定論的）
  mqtt-server.ts     TLS MQTT broker（aedes）。report/request トピックを仮想プリンターに接続
  topics.ts          Bambu MQTT トピック/コマンド規約（実機に合わせる際はここだけ直す）
  control-api.ts     __control 裏口 + /api/diagnostics（spec 20.4/20.5/20.7）
  ticker.ts          実時間の印刷進行ドライバ（本番プロセス専用。テストは使わない）
  tls.ts             自己署名証明書の生成/読込
  main.ts            単一プロセスとして全部を起動
```

## 決定論の要

コア `VirtualPrinter` は**内部タイマーを持たない**。進行は呼び出し側が明示的に進める：

- 本番（`main.ts`）… `Ticker` が `speedFactor` に応じて `tick()` を刻む
- テスト … `tick()` を手で回すか `forceFinish()` で即完了（`scenarios/README.md` の
  `finish_current` に対応）。wall-clock に依存しないので CI が安定する

`on_state_transition:FINISH` fault は FINISH レポートを**握り潰し**、`pushAll()`（再接続時の
フルポーリング）でのみ表面化する。これが取りこぼし再同期（INV-RESYNC-01/02）の検証土台。

## 起動

```bash
bun install
bun run stub          # :8883 MQTT(TLS), :3001 control/HTTP
# env: STUB_MQTT_PORT / STUB_HTTP_PORT / STUB_SPEED_FACTOR / STUB_SERIAL / STUB_ACCESS_CODE
```

## テスト（プログラムによる検証機構）

```bash
bun test              # 全部
bun test test/stub    # スタブのみ
```

- `virtual-printer.test.ts` … state machine 単体（開始/完走/失敗/fault/AMS/resync）
- `mqtt-integration.test.ts` … 実 TLS MQTT クライアントで疎通し status を観測（Phase 1 完了条件）
- `control-api.test.ts` … `__control` / `/api/diagnostics`（サーバ不要、`app.request`）

## __control API（テスト用裏口）

| method | path | body | 効果 |
|---|---|---|---|
| POST | `/__control/ams/:slot` | `{remaining_g?, color?, type?}` | AMS スロット残量/色/種を設定 |
| POST | `/__control/fault` | `{category, timing}` | fault 注入（spec 20.5） |
| POST | `/__control/finish` | — | 現在の印刷を即完了 |
| POST | `/__control/fail` | `{code?}` | 即 FAILED |
| POST | `/__control/speed` | `{factor}` | speedFactor 変更 |
| POST | `/__control/print_minutes` | `{minutes}` | 印刷長（sim分）設定 |
| POST | `/__control/reset` | — | IDLE に戻す |
| GET  | `/__control/state` | — | 現在の真の状態レポート |
| GET  | `/api/diagnostics` | — | 疎通スナップショット（spec 20.7） |
| GET  | `/api/printer/snapshot` | — | 固定 PNG |

## 未実装（次の増分）

- **implicit FTPS（990）** … `diagnostics.ftps_reachable` は現在 `false` 固定。
  ディスパッチ（⑥）の「FTPS送信→MQTT印刷開始」を通すため Phase 2 で追加。
- 実機トピック/ペイロード名の突き合わせ（`topics.ts` / `types.ts` を実機ログで確定）。
- `pause`/`resume`/`gcode_line`、HMS一時停止からの別スロット再開（spec 14/16、Phase 5）。
