# Bambu プロトコル実装ノート（実機準拠のための参照）

`maziggy/bambuddy` の `backend/app/services/virtual_printer/` 調査結果と、標準 Bambu LAN
MQTT スキーマから、A1 mini スタブ／オーケストレーターが準拠すべき事実をまとめる。
出典は bambuddy の各ファイル（`main` ブランチ）。

> ⚠️ **bambuddy の vp はスライサー向けアップロードスタブであり、挙動シミュレータではない**。
> RUNNING/進行/AMS/HMS は proxy モード（実機ミラー）でしか埋まらない。よって印刷進行・
> AMS残量・fault の**振る舞いは自前実装**（= 本リポジトリの `virtual-printer.ts`）。
> bambuddy から採るのは**ワイヤ形式（トピック・ペイロード名・FTPS作法）だけ**。

## MQTT（`mqtt_server.py`）

- コマンド受信: `device/{serial}/request`
- レポート送信: `device/{serial}/report`
- ガード: トピックは `device/` 始まりで `/request` を含むこと
- フルダンプ要求: `{"pushing":{"command":"pushall"}}`（または `"start"`）→ 即フルレポート。通常は約1Hz
- `project_file` 応答（report トピックへ）: `{"print":{"command":"project_file","result":"SUCCESS","msg":0}}`
  → 本スタブは `mqtt-server.ts publishAck()` で再現済み

レポート内側（`print` の値）の確定フィールド名:
```
command:"push_status", msg:0, gcode_state, gcode_file, gcode_file_prepare_percent,
subtask_name, mc_print_stage(文字列int), mc_percent, mc_remaining_time,
stg[], stg_cur, layer_num, total_layer_num, print_error,
bed_temper, bed_target_temper, nozzle_temper, nozzle_target_temper, chamber_temper,
spd_lvl, spd_mag, home_flag, sdcard, ams_status, nozzle_diameter, nozzle_type ...
```
本スタブ `types.ts PrintReport` は上記の実用サブセットを実装。

### AMS（標準スキーマ、bambuddy synthetic では空）
```
ams: {
  ams: [{ id:"0", humidity:"5", temp:"30.0",
          tray: [{ id:"0", tray_type:"PLA", tray_color:"RRGGBBAA", remain:100 /*%,-1不明*/ }, …4] }],
  ams_exist_bits:"1", tray_exist_bits:"f", tray_now:"0", tray_tar:"255"
}
```
- `remain` は**％**（実機はグラムを報告しない）。本スタブは内部 grams → % 変換
- **⚠️ 実機は AMS を*差分*でpushする**（bambuddy `_merge_ams_dict` がマージ）。
  本スタブは常に全状態を送るので、**オーケストレーター側の差分マージ実装は別途テストが必要**
  （Phase 2 の MQTT クライアント要件）

### HMS（fault チャネル）
`hms: [{attr:<uint32>, code:<uint32>}]`、空配列＝正常。本スタブの fault 注入はここに載る。

### gcode_state 正準集合
`IDLE, PREPARE, RUNNING, PAUSE, FINISH, FAILED`。RUNNING 中は `mc_percent` 0→100、
`mc_remaining_time` カウントダウン、`layer_num/total_layer_num` で層進行（自前実装済み）。

## FTPS（`ftp_server.py`）— Phase 2 実装仕様

| 項目 | bambuddy(X1系) | **本A1スタブが採る値** |
|---|---|---|
| ポート | 990 implicit（接続直後にTLS） | 同じ |
| TLS版 | **TLS1.2 のみ**（1.3でBambuStudioが途中で壊れた） | 同じ（1.2固定） |
| cipher | `HIGH:AES256-GCM-SHA384:AES128-GCM-SHA256:!aNULL:!MD5:!RC4` | 同じ |
| `PROT P` | `200 Protection level set to Private` | 同じ |
| **`PROT C`** | **`536 not supported`（拒否）** | **⚠️ 受理する（spec 20.6）** |
| USER | `bblp` 固定 | 同じ |
| PASS | LANアクセスコードを `hmac.compare_digest` | 同じ |
| STOR | `upload_dir` へ 64KiB チャンク、`Path(arg).name` にサニタイズ、上限4GiB | 同じ |
| PASV/EPSV | VPごとにポートスライス、制御IPを広告 | 同様 |

> **★最重要の相違点**：bambuddy は `PROT C` を**拒否**するが、**A1/A1 mini は実機で
> `PROT P` 要求に対し平文 `PROT C` へフォールバックする癖**がある（spec 20.6, 19章の
> 未検証項目）。本A1スタブは **PROT C を受理して平文データチャネルを開く**挙動も再現し、
> オーケストレーターの FTPS クライアントが P/C 両対応かを検証する。ここは bambuddy と
> 意図的に逆にする。

## 発見・接続（オーケストレーターは既知IP接続なので優先度低）

- **SSDP**（`ssdp_server.py`）: `255.255.255.255:2021` へ**ブロードキャスト**NOTIFY、30秒間隔。
  ヘッダ `NT: urn:bambulab-com:device:3dprinter:1`, `USN:{serial}`,
  `DevModel.bambu.com`（X1C=`BL-P001`、**A1 mini は要実機確認、通説 `N2S`**）
- **bind/detect**（`bind_server.py`）: TCP **3000(平文)/3002(TLS)**。A1 Mini 01.07.x は 3002/TLS。
  応答 `{"login":{"command":"detect","bind":"free","connect":"lan","dev_cap":1,"id":,"model":,"name":,"sequence_id":3021,"version":}}`

## 実機実測ノート（A1 mini + BMCU、2026-07-02 検証 Stage 1-4）

Windows ラップトップ上のオーケストレーター/診断から実 A1 mini に対して確認した一次データ。

### FTPS
- **PROT P は受理される**（`PROT P → 200`）。データチャネル（LIST/STOR）も P のまま成立。
  spec 20.6 が警戒していた「PROT C への強制フォールバック」は**この個体・FWでは観測されず**。
  ただしスタブは引き続き P/C 両対応を維持する（FW差の可能性は残る）。
- **セッションスロットは実質1つ**。QUIT を送らずソケットを破棄すると、プリンター側が
  そのセッションを**1〜3分保持**し、次の接続は Timeout / ECONNREFUSED になる。
  **QUIT を送れば即時解放**（直後の再接続が約2秒で成立、実験で確認）。
  → 対策実装済み: 全FTPS操作を `runSerialized`（`ftps-session.ts`）で直列化し、単一スロットの
  競合を根絶。診断セッションは QUIT を必ず送出。アップロードは curl が自前でクリーン終了する。
- 短時間に接続試行を繰り返すと FTPS サーバー自体が wedge し、ECONNREFUSED を返し続ける
  ことがある。**プリンター再起動で回復**。連打・並行接続は構造的に避けること。
- `/cache` には過去の印刷ファイルが大量に残留する（数十件・数百MB規模を確認）。
- **STOR は `/cache/<name>` を指定すること**。SDルートへの `STOR <name>` は実機ファームが
  **応答を返さず握りつぶす**（226が来ない→制御ソケットtimeout→放置セッションがwedgeの引き金）。
  LIST はどこでも成功するため、診断が緑でもアップロードだけ死ぬ、という紛らわしい症状になる。
  フェーズログ（`session open: TLS+login ok (+899ms)` の後に body done が出ない）で特定。
  スタブは basename に正規化するのでこの差を検出できない（スタブ強化の余地）。
- **★PROT P アップロードは close_notify 必須**（生TLSレコード観測＋厳格模倣サーバーで機序を実証）。
  実機はデータ接続が close_notify なしで FIN されると転送を「途中切断」とみなし **226 を返さない**。
  curl（schannel、close_notify送信）は成功、Bun+basic-ftp は常にハング。
- **⚠Bun の TLS 制約 2 点**（Bun 1.3.14 時点、要追跡）:
  (1) `TLSSocket.end()` が **close_notify を送らない**（素のFINのみ。生レコード:
  `handshake ccs appdata… → FIN`、ALERTレコード無し）。
  (2) `tls.connect`/`createServer` の **`minVersion`/`maxVersion` を無視**する
  （1.2固定を指定しても制御接続は TLS1.3 でネゴした）。
- **実機は「PROT C」を `200` で受理しつつ、平文データ接続が来ると制御ごと FIN で切断**する
  （＝口先だけ受理、実際はデータTLS必須）。トレースで確認: PROT C→200 / STOR→150 の直後、
  平文データ接続で制御に FIN。→ 自前の平文データチャネル案（旧 `ftps-transfer.ts`）は**却下**。
- **node-forge も不可**: TLS1.0/1.1 どまりで、実機の TLS1.2 + AES-GCM に非対応
  （データTLSハンドシェイクが `Unsupported protocol version` で失敗）。
  → **結論: アップロードは curl に委譲**（`src/orchestrator/ftps-curl.ts`）。curl は正常な
  close_notify を送るため実機で 226 を得られる唯一のクライアントだった。制御チャネルの診断
  （`checkFtps`）は Bun ネイティブのまま（LIST/PROT 応答は close_notify 不要で成立）。
- **EPSV は 502 で拒否**（curl 実測）。curl は `--disable-epsv`、診断の basic-ftp は
  EPSV→PASV 自動フォールバックで対応。
- 実機の制御応答はテキスト部が空（`226 `、`502 ` 等）。パーサはコード+空白のみで解釈すること。

### MQTT / report
- `pushall` でフルダンプ取得可。`tray_color` は **"RRGGBBAA"**（`FFFFFFFF` 等、'#'なし・α付き）
  — `src/core/color.ts` の正規化対象そのもの。
- BMCU は AMS として見える（`ams_exist_bits:"1"`、4トレイ、`humidity:"5"`）。
  **`remain: -1`（残量%不明）**を返す — 残量ベースの runout 検知は BMCU では
  レポートに依存できない可能性が高い（要追加検証）。
- **IDLE 中でも `hms` が空でないことがある**（残留エントリを確認: attr 83887104 / code 65604、
  `print_error` も非0）。「hms非空＝異常」ではない。monitor の FAILED 判定が
  gcode_state 駆動なのは正しい設計だった。
- IDLE 中の `subtask_name` は**直前に印刷したジョブ名を保持し続ける**。
  完了検知を subtask 名だけに頼ってはいけない（エッジ検出必須）。

## テスト観点（bambuddy が黙っている＝自前で担保すべき箇所）
- 印刷進行の時間シミュレーション（本スタブ: `tick()`/`Ticker`）
- AMS残量・色・種の可変設定と runout（本スタブ: `__control/ams`）
- fault 注入（printer/swap/transient、on_state_transition:FINISH の取りこぼし）
- AMS 差分マージ（オーケストレーター側、Phase 2）
- FTPS PROT C フォールバック（本スタブ側で再現、Phase 2）
