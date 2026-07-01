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

## テスト観点（bambuddy が黙っている＝自前で担保すべき箇所）
- 印刷進行の時間シミュレーション（本スタブ: `tick()`/`Ticker`）
- AMS残量・色・種の可変設定と runout（本スタブ: `__control/ams`）
- fault 注入（printer/swap/transient、on_state_transition:FINISH の取りこぼし）
- AMS 差分マージ（オーケストレーター側、Phase 2）
- FTPS PROT C フォールバック（本スタブ側で再現、Phase 2）
