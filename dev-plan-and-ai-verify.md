# 開発計画 & AI活用自動verify機構

本書は `multiplate-auto-print-spec.md` を現実のシステムに落とし込むための、(A) フェーズ分けされた開発計画と、(B) スタブ環境を土台にしたAI主導の自動検証機構を定義する。

---

# A. 開発計画

## 設計原則：不確実性の高い順に潰す

仕様書19章の未解決事項は、ほとんどが「実機/プロトコルの挙動が確定していないこと」に起因する。これらは後で発覚すると手戻りが大きいため、**UIや快適機能より先に、プロトコル境界とstate machineを固める**順序にする。

```
Phase 0  足場          … リポジトリ・CI・型・DBマイグレーション基盤
Phase 1  スタブ        … printer-stub（MQTT+FTPS）を先に作る ★最重要
Phase 2  プロトコル境界 … MQTT/FTPSクライアント、診断エンドポイント
Phase 3  コアループ     … キューstate machine、ディスパッチ、ETA
Phase 4  注入          … G-code注入、MD5再計算、ヘッドレススライス
Phase 5  異常系        … pending_actions、フィラメント切れ解決、プロジェクト
Phase 6  UI            … Webアプリ、3Dプレビュー、対応待ちバナー
Phase 7  ゲートウェイ   … 自前Mosquitto再publish、IoT、通知
Phase 8  実機移行       … スタブ→実機切替、未解決事項の実機確認
```

スタブ（Phase 1）をコアループ（Phase 3）より前に置くのが肝。スタブが無ければコアループのテストが書けず、AI verifyも回せない。スタブは「最初に作る検証インフラ」であって、後回しのテスト用品ではない。

## 各フェーズの詳細

### Phase 0：足場（〜数日）
- Bun + Hono + TypeScriptプロジェクト初期化、`bun:sqlite`
- DBマイグレーション基盤（spec 4章のスキーマ）
- CIパイプライン（lint / typecheck / test / build）の骨組みだけ先に通す
- **完了条件**：空のテストがCIで緑になる

### Phase 1：printer-stub ★最重要（〜1.5週）
- spec 20章を実装。MQTT broker（TLS）+ implicit FTPS（990）+ `__control` API
- state machine（IDLE→RUNNING→FINISH/FAILED）、`speedFactor`、AMS残量設定、fault injection
- A1のPROT Cフォールバック、`on_state_transition:FINISH`切断を再現
- **完了条件**：`__control`で印刷を開始・完走・失敗させられ、MQTTでstatusが観測できる
- **参照**：bambuddyの`backend/app/services/virtual_printer/`

### Phase 2：プロトコル境界（〜1週）
- MQTTクライアント（reportパース、コマンドpublish）
- FTPSクライアント（implicit 990、PROT C/P両対応）
- `GET /api/diagnostics`（spec 20.7）
- **完了条件**：オーケストレーターがスタブに対し疎通診断を通し、印刷開始コマンドを送れる

### Phase 3：コアループ（〜2週）
- キューstate machine（processing→queued→printing→success/failed）
- ディスパッチャー（ストッカーチェック→プロジェクトブロックチェック→送信）
- ETA計算、ストッカー残数管理
- **完了条件**：複数ジョブをキューに積み、スタブ上で順番に「印刷」して完走できる（=シナリオ S1, S2 が緑）

### Phase 4：注入パイプライン（〜1.5週）
- 3MFパース（サムネ・フィラメント・メッシュ）
- G-code注入、`{name}`解決、**MD5サイドカー再計算**
- ヘッドレススライス（OrcaSlicer CLIサイドカー、後回し可）
- **完了条件**：注入済み3mfがスタブのFTPSに受理され、MD5検証を通る

### Phase 5：異常系（〜2週）
- pending_actions統一モデル
- フィラメント切れ段階的解決（Tier 0〜3）
- プロジェクト所属とcolor_consistency_policy（strict/propagate）
- **完了条件**：fault injectionで誘発した各異常が、正しいpending_actionに振り分けられる（=シナリオ S3〜S8 が緑）

### Phase 6：UI（〜2週）
- Hono SSR + htmx + SSE、対応待ちバナー、3Dプレビュー
- **完了条件**：ブラウザからアップロード→確認→キュー投入→監視が一通りできる

### Phase 7：ゲートウェイ・通知（〜1週）
- 自前Mosquitto再publish、Discord/Slack Webhook、IoT購読
- **完了条件**：失敗時にWebhookが飛び、M5Stack相当が状態を受信できる

### Phase 8：実機移行（〜1週＋実機待ち）
- 接続先をスタブ→実機に切替、19章の実機確認項目を順に潰す
- `SWAP_DURATION_MS`・ストッカーcapacityの実測キャリブレーション
- **完了条件**：スタブで緑だったシナリオの主要分が実機でも再現する

## クリティカルパス

```
Phase0 → Phase1(stub) → Phase2 → Phase3 ──→ Phase5 ──→ Phase8(実機)
                                    └→ Phase4 ┘   └→ Phase6 → Phase7（並行可）
```

Phase 4（注入）とPhase 6/7（UI/通知）はコアループが固まれば並行できる。実機（Phase 8）はハードウェアの準備が整い次第いつでも始められるよう、Phase 3完了時点で「実機にも向けられる」状態を維持しておく。

---

# B. AI活用自動verify機構

## 基本思想：スタブ＝決定論的サンドボックス、AI＝シナリオ生成と判定

実機は遅く・消耗し・非決定論的で、AIに何度も叩かせるのに向かない。だが**spec 20章のスタブは「無限に速く・無料で・決定論的」**なので、AIエージェントが何千回でもシナリオを流せる理想的な検証対象になる。

この機構は3つのAIの使い所を持つ：

```
①仕様→不変条件   spec.md から機械可読なinvariantを抽出（AIが下書き、人間がレビュー）
②シナリオ生成     invariantを破りにきわどいシナリオをAIが量産
③実行と判定       スタブ上でシナリオを流し、結果をAIが不変条件と突き合わせて判定
```

## ①仕様の不変条件化（machine-readable invariants）

仕様書の自然言語の記述を、検証可能な不変条件に落とす。これがAI verifyの「正解」になる。

```yaml
# invariants.yaml （AIが下書き、人間が承認してリポジトリ管理）
invariants:
  - id: INV-STOCKER-01
    desc: "ストッカー残数は決して負にならない"
    check: "stocker.remaining >= 0 at all times"

  - id: INV-STOCKER-02
    desc: "スワップ1回ごとに残数がちょうど1減る"
    check: "on swap_executed, remaining decreases by exactly 1"

  - id: INV-DISPATCH-01
    desc: "あるプロジェクトがcolor_decision待ちでも、別プロジェクトのジョブは進む"
    check: "blocked project does not block other projects' queued jobs"

  - id: INV-RUNOUT-01
    desc: "manualポリシー時、フィラメント切れは必ずpending_actionを生む"
    check: "policy=manual AND runout => pending_action(filament_runout) created"

  - id: INV-RUNOUT-02
    desc: "色が代替されたジョブは完了通知に必ずその旨が含まれる"
    check: "substituted_color != null => finish notification mentions substitution"

  - id: INV-INJECT-01
    desc: "注入後のgcodeは必ずMD5サイドカーが再計算されている"
    check: "after injection, plate_N.gcode.md5 matches sha of new plate_N.gcode"

  - id: INV-RESYNC-01
    desc: "FINISH直前に切断されても、再接続後に完了が検知される"
    check: "fault(on_state_transition:FINISH) => job eventually reaches success"
```

不変条件は実装より先に書く（テスト駆動の精神）。仕様変更時は必ずこのファイルも更新し、「仕様＝不変条件＝テスト」を一致させる。

## ②シナリオ生成（AIが敵対的に攻める）

不変条件1つにつき、それを破りにいくシナリオをAIに量産させる。シナリオは`__control` API呼び出しの列として表現する。

```yaml
# scenarios/S5-runout-during-project.yaml （AI生成、人間が抜き取りレビュー）
name: "プロジェクト3プレート中、2枚目で色違い代替が発生（strict）"
targets: [INV-RUNOUT-02, INV-DISPATCH-01]
setup:
  project: { name: "test", color_consistency_policy: "strict" }
  jobs: [plateA, plateB, plateC]  # 全て同プロジェクト
  ams:
    - { slot: 0, color: "#FF0000", type: "PLA", remaining_g: 5 }   # まもなく切れる
    - { slot: 1, color: "#0000FF", type: "PLA", remaining_g: 800 } # 同タイプ別色
  system_settings: { filament_runout_policy: "allow_material_match" }
steps:
  - dispatch_all
  - wait_until: { job: plateB, state: printing }
  - control: { POST: /__control/ams/0, body: { remaining_g: 0 } }  # 2枚目印刷中に枯渇
  - assert: { pending_action: color_decision, exists: true }       # strictなので停止
  - assert: { job: plateC, state: queued }                         # 後続は止まったまま
expect:
  - INV-RUNOUT-02: plateB finish notification mentions substitution
  - INV-DISPATCH-01: 別プロジェクトを足せばそちらは進む（派生シナリオ）
```

AIへの指示は「この不変条件を、最小手数で破壊できるシナリオを考えて」という敵対的プロンプトにする。人間が思いつかないタイミング差・順序依存（例：FINISHと切断の競合、スワップとストッカー枯渇の同時発生）を引き出すのが狙い。

## ③実行と判定（AI verifyランナー）

```
┌─────────────────────────────────────────────┐
│ AI Verify Runner（CI上 or Claude Code Remote）│
│                                               │
│  for each scenario:                           │
│    1. スタブ起動（クリーンstate）             │
│    2. オーケストレーター起動（接続先=stub）   │
│    3. シナリオのsteps/controlを順次実行       │
│    4. 各assert・最終状態を収集                │
│    5. invariantsと突き合わせ                  │
│       ├ 機械的に判定できる → コードでassert    │
│       └ 曖昧（通知文面等） → AIが意味判定      │
│    6. 失敗時：state遷移ログ+MQTT履歴をAIが要約 │
└─────────────────────────────────────────────┘
```

判定を2層に分けるのがポイント：

- **機械判定層**：`remaining >= 0`、`state == queued`のような厳密な条件は普通のassertで高速・確定的にチェック。CIの大半はここで緑/赤が決まる
- **AI判定層**：「完了通知の文面が代替の事実を伝えているか」のような自然言語的・意味的な検証だけAIに委ねる。ここはAIに通知ペイロードと不変条件INV-RUNOUT-02を渡し、「満たしているか/いないか＋理由」を返させる

AI判定層を絞り込むことで、AIの非決定性がCI全体を不安定にするのを防ぐ。AIは「人間でないと判定が面倒な箇所」だけに使う。

## CI統合とAIの3つの役割

```
PR作成
 ├─ 通常CI（lint/typecheck/build）
 ├─ シナリオスイート実行（スタブ上、機械判定層）   ← 速い・確定的
 └─ AIレビューjob（非ブロッキング、post-merge可）
      ├─ 役割1: 差分が触れた不変条件を特定し「このPRはINV-Xに影響」とコメント
      ├─ 役割2: 新シナリオの不足を指摘「この分岐をカバーするシナリオが無い」
      └─ 役割3: AI判定層の意味的検証（通知文面・エラーメッセージの妥当性）
```

bambuddyのCI（Ruff+pytest+pip-audit+Dockerビルド+ヘルスチェック）を下敷きにしつつ、その上に「シナリオスイート」と「AIレビューjob」を乗せる構成。

## AIエージェントの実行基盤

手元にあるツールで、この機構は段階的に立ち上げられる：

- **Claude Code**：①不変条件の下書き、②シナリオ生成、コード実装そのものを対話的に進める
- **Claude Code Remote**：スタブ＋オーケストレーターを起動して長尺シナリオを流す検証ジョブを、リポジトリに対してリモート実行・スケジュール実行する。夜間に全シナリオ＋AI生成の新規シナリオを回し、朝に結果を受け取る運用が組める
- **scheduled trigger**：「毎晩、不変条件に対して新しい敵対的シナリオをN件生成して実行し、新たに破れたものがあれば通知」という回帰検出ループを常駐させる

## この機構が効く理由（まとめ）

1. **スタブが決定論的サンドボックスなので、AIに無限に試行させられる** — 実機では不可能
2. **不変条件を中心に据えることで、AIの出力（シナリオ・判定）の正しさを人間が承認可能な単位に保てる** — AIに丸投げせず、AIは「探索」を担い人間は「承認」を担う
3. **異常系（本システムの本体）こそAIの敵対的シナリオ生成が活きる** — 正常系より、順序・タイミング・競合が絡む異常系の方がAIの探索価値が高い
4. **仕様＝不変条件＝テストの三位一体** — 仕様変更が必ずテストに反映され、ドキュメントとコードの乖離を防ぐ

---

## 次の具体アクション

1. `invariants.yaml` の初版をAIに下書きさせ、人間がレビューして確定（仕様書の各章から機械的に抽出可能）
2. Phase 0+1（足場＋スタブ）に着手。スタブができた時点で、上記verify機構の②③が回り始める
3. 最初のシナリオ S1（単一ジョブ完走）・S2（複数ジョブ連続）を手書きし、機械判定層だけで緑にする
4. 以降、各Phaseの「完了条件」をシナリオとして表現し、AIに派生シナリオを膨らませてもらう
