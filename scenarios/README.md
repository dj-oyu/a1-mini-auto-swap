# scenarios/ — AI verify シナリオスイート

`dev-plan-and-ai-verify.md` の「②シナリオ生成・③実行と判定」の実体。
各シナリオは `invariants.yaml` の不変条件を **破りにいく / 守れることを示す** 一連の
`__control` API 呼び出しと assert の列。`printer-stub`（spec 20章）上で決定論的に流す。

この README は **ランナーDSLの契約**。S1/S2 が最初に使い、以降の全シナリオが従う。
DSLを増やすときは必ずここを更新する（仕様＝不変条件＝テストの三位一体に倣い、DSLも一元管理）。

---

## ファイル構造

```yaml
name:    "人間向けの一文。何を検証するか"
targets: [INV-XXX-NN, ...]   # このシナリオが触れる不変条件（トレーサビリティ）
setup:   { ... }             # スタブ＆DBの初期状態
steps:   [ ... ]             # 上から順に実行されるアクション/待機/assert
expect:  [ ... ]             # 終了時にまとめて確認する不変条件（特に layer: ai のもの）
```

`steps` 内の `assert` は機械判定層（即時・確定的）。
`expect` は終了状態に対する不変条件の突き合わせで、`layer: ai` の項目はここでAI判定に回す。

---

## setup キー

| キー | 意味 |
|---|---|
| `project` | `{ name, color_consistency_policy: strict\|propagate }`。省略時はプロジェクト無し |
| `jobs` | ジョブ定義の配列。各要素 `{ id, project?, est_seconds?, filaments?, ams_mapping? }`。`id` はシナリオ内で参照する論理名（例 `plateA`） |
| `ams` | スタブAMSスロット初期値の配列 `{ slot, color, type, remaining_g }` |
| `stocker` | `{ capacity, remaining }` |
| `system_settings` | `{ filament_runout_policy: manual\|same_color_only\|allow_material_match, ... }` |
| `speed_factor` | スタブの倍速。既定 1000（spec 20.3）。決定論のため整数で固定 |

---

## steps ボキャブラリ

### アクション
| step | 意味 |
|---|---|
| `upload: <jobId>` | そのジョブを `POST /api/queue` 相当でシステムに投入（status: processing から開始） |
| `confirm_filaments: <jobId>` | `PATCH /api/queue/:id/filaments` 相当。AMS一致なら advisory 自動queued（INV-PENDING-01） |
| `dispatch_all` | ディスパッチャを起動し、投入可能なものを順次送る |
| `control: { POST: <path>, body: {...} }` | スタブの裏口 `__control` を叩く（残量変更・fault注入等） |
| `resolve_pending: { type: <t> }` | `POST /api/pending-actions/:id/resolve` 相当 |
| `retry: <jobId>` | `POST /api/queue/:id/retry` 相当（人間操作の代理。自動retryは存在しない＝INV-QUEUE-02） |
| `refill_stocker` | `POST /api/stocker/refill` 相当 |

### 待機（決定論的バリア）
| step | 意味 |
|---|---|
| `wait_until: { job: <id>, state: <s> }` | 指定ジョブが状態 `s` に達するまでブロック。タイムアウトは失敗扱い |
| `wait_until: { pending_action: <type>, exists: true }` | 指定タイプの未解決 pending_action が現れるまで待つ |
| `finish_current` | スタブの現在印刷を `FINISH` まで早送りして完了させる（`control: { POST: /__control/finish }` のショートカット） |

### 検証（機械判定層）
| assert 形 | 意味 |
|---|---|
| `assert: { job: <id>, state: <s> }` | ジョブが状態 `s` であること |
| `assert: { stocker: { remaining: <n> } }` | ストッカー残数 |
| `assert: { pending_action: <type>, exists: <bool> }` | 指定タイプの未解決 pending_action の有無 |
| `assert: { invariant: INV-XXX-NN }` | named invariant をその時点で評価（ランナーが INV→チェック関数を引く） |
| `assert: { printing_count: <n> }` | `status == printing` のジョブ数（単機なら 0 か 1） |

---

## ストッカー会計の約束（INV-STOCKER-02/03、要注意点）

spec 11章：**スワップが起きるたびに remaining -1**。印刷完了は必ずスワップ（完了プレート排出
→ストッカーから新規プレート供給）を伴うので、**1完走 = remaining -1**。
セッション開始時に既にベッド上にある1枚はストッカー由来ではないため、開始時点での
事前デクリメントはしない（＝開始 remaining はそのまま capacity に等しく設定してよい）。

したがって N枚連続完走後の残数は `初期remaining - N`。S1/S2 の assert はこの規約に従う。
（この会計はレビューで人間確認すべき箇所として `invariants.yaml` INV-CONSISTENCY-01 に紐づく）
