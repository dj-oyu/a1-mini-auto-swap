# プリントヘッド可視化とドライリハーサル仕様

> 既存の `multiplate-auto-print-spec.md` への追加チャプターを想定した独立文書です。章番号は本体側で採番し直してください。

## 1. 目的

実機のスワップ機構における振動耐性、および所定のG-codeが正しく送出されているかを、フィラメントと加熱を使わずに高速・反復的に検証する。

## 2. 生成方針

**スライサー出力は使用しない。プログラマブルに直接生成する。**

スライスする対象の3Dモデルが存在しないため、スライサー出力を流用すると加熱系コマンド・レベリング・キャリブレーションマクロの除去という余計な作業が発生する。TypeScriptのビルダー関数群として実装し、GUI操作を介さずパラメータ変更だけでテストパターンを調整できるようにする。

## 3. レイヤー構成

軸(X/Y/Z)ごとに1レイヤーとし、合計3レイヤー構成とする。各レイヤーの内部構成は以下の順序で固定する。

1. 対象軸の単軸スイープ(往復動作)
2. 8の字ダンス(複合軸フラリッシュ)

レイヤー境界には `;LAYER_CHANGE` / `;Z:` / `;HEIGHT:` 相当のコメントを挿入する。可視化機能側のレイヤー同期機構とマーカー規約を揃えておくことで、追加コストなくブラウザ可視化に接続できる状態を維持する。

```
Layer 1: X軸スイープ → 8の字ダンス
Layer 2: Y軸スイープ → 8の字ダンス
Layer 3: Z軸スイープ → 8の字ダンス(Z軸到達高さで実行)
```

## 4. 各要素の仕様

### 4.1 単軸スイープ

対象軸を安全範囲内で往復させる。振動特性を軸単体で切り分けて観測することが目的のため、他軸は動かさない。

- 入力: 軸、継続時間(ms)、振幅(mm)、feedrate、安全境界
- 移動距離とfeedrateから1往復あたりの所要時間を逆算し、継続時間に収まる往復回数を算出する

### 4.2 8の字ダンス

単軸スイープでは検出できない複合軸方向の共振・干渉を検出するためのフラリッシュ。ジェロノのレムニスケート軌道を使用する。

```
x(t) = centerX + A·sin(t)
y(t) = centerY + A·sin(t)·cos(t)     (t: 0 → 2π)
```

離散化して `G1` の連続移動列に変換する。Z軸レイヤーでは、そのレイヤーのZ軸スイープ到達高さでXY平面の8の字を描く(暫定仕様、10章の要検証事項を参照)。

## 5. 安全要件

- テストgcode全体の先頭で一度だけ `G28`(全軸ホーミング)を実行する。未ホーミング状態での絶対座標移動はフレーム衝突のリスクがあるため省略不可
- 全ての移動先座標はプリンター筐体の可動範囲から安全マージンを引いた範囲にクランプする
- ヒーター系コマンド(M104/M140/M109/M190)、および押出(E)は一切含めない

## 6. 配信方式

| 方式 | 用途 |
|---|---|
| `gcode_line` | 第一候補。ファイル転送不要で即時実行できるため、反復テストの速度要件に最も合致する |
| `gcode_file` | `gcode_line`に収まらない長尺テストへのフォールバック。裸の`.gcode`をFTPSでアップロードし、ファイル名指定で実行(3mf化不要) |
| `project_file`(3mf経由) | **不採用**。Developer Mode要件と3mf構築コストが不要な複雑さを持ち込むため |

2025年1月以降のファームウェアでは未署名コマンドが拒否されるため、送信側にX.509署名の実装が別途必要になる(10章)。

## 7. 可視化との連携

### 7.1 バックエンド連携

ドライリハーサルはプリンター側から見れば通常のプリントジョブと同一経路を通るため(`gcode_line`/`gcode_file`いずれも`gcode_state`/`mc_percent`/`layer_num`を通常のプリントと同じ形式でMQTT報告する)、以前設計したブラウザ可視化(バックエンドでレイヤー単位に分解しWebSocketで進行を配信)は追加実装なしでそのまま接続できる。本仕様の`;LAYER_CHANGE`マーカーは、可視化バックエンドのレイヤー境界検出ロジックと同じ規約で挿入しているため、バックエンド側は軸テストgcodeか実際のスライス済みgcodeかを区別する必要がない。

なお本テストは全体で3レイヤー・数十秒程度と小規模なため、大規模プリント向けに検討していたバイナリ点列への事前変換(帯域最適化)は不要とする。レイヤーごとの生テキストをそのままWebSocketで送る簡易経路で十分。

### 7.2 ブラウザ側の実装

クライアントは`gcode-preview`(Three.jsベース)を用い、WebSocketで届いたレイヤーテキストを受信のたびに`preview.processGCode(layerText)`へ渡す。ライブラリ側が幾何情報を累積してくれるため、自前でThree.jsのメッシュ管理を書く必要はない。

**要注意設定: 移動モードの可視化**
本テストのG-codeは押出(E)を一切含まない全行が「移動のみ」の行になる。多くのG-codeビューアはデフォルトで非押出移動(トラベル)を非表示または薄く描画する仕様のため、既定設定のままでは画面に何も表示されない。`showTravelMoves`相当のオプションを明示的に有効化し、非押出移動を通常の線として描画する設定に切り替える必要がある。

**配色**
押出有無で色分けする通常プリント用の配色ロジックは意味を持たないため、パスの種類(単軸スイープ/8の字ダンス)またはfeedrateで色分けする設定に切り替える。軸スイープは直線的、8の字ダンスは曲線的なので、色分けせずとも軌跡の形状だけで区別は可能だが、切り替わりの瞬間を分かりやすくする目的で色分けを推奨する。

**見え方の注記**
通常プリントは各レイヤーでZが単調増加するのに対し、本テストのレイヤーはZがほぼ一定(X/Y軸レイヤー)または特定高さで往復する(Z軸レイヤー)ため、積層物のような見た目にはならず、3本のスイープ軌跡と8の字パターンが空間に描かれるだけの表示になる。これは仕様通りの挙動であり、可視化側の不具合ではない。用途は振動テストが想定範囲・タイミングで実行されているかを目視確認する簡易モニターであり、振動計測など定量評価の代替にはならない。

**カメラ/画角**
通常プリントは1オブジェクト周辺にカメラが収まるが、本テストはビルドボリューム全体を使って軸を振るため、初期カメラ位置はビルドボリューム全体が収まるフレーミングに設定する。

## 8. インターフェース例(TypeScript)

```ts
type Bounds3D = {
  x: { min: number; max: number }
  y: { min: number; max: number }
  z: { min: number; max: number }
}

function axisSweep(
  axis: 'X' | 'Y' | 'Z',
  durationMs: number,
  amplitudeMm: number,
  feedrate: number,
  bounds: { min: number; max: number },
): string {
  const center = (bounds.min + bounds.max) / 2
  const lo = Math.max(bounds.min, center - amplitudeMm / 2)
  const hi = Math.min(bounds.max, center + amplitudeMm / 2)
  const moveTimeMs = (Math.abs(hi - lo) / feedrate) * 60000
  const reps = Math.ceil(durationMs / (moveTimeMs * 2))
  const lines: string[] = []
  for (let i = 0; i < reps; i++) {
    lines.push(`G1 ${axis}${hi.toFixed(2)} F${feedrate}`)
    lines.push(`G1 ${axis}${lo.toFixed(2)} F${feedrate}`)
  }
  return lines.join('\n')
}

function figureEightDance(
  centerX: number,
  centerY: number,
  z: number,
  amplitudeMm: number,
  feedrate: number,
  segments = 48,
): string {
  const lines: string[] = []
  for (let i = 0; i <= segments; i++) {
    const t = (i / segments) * 2 * Math.PI
    const x = centerX + amplitudeMm * Math.sin(t)
    const y = centerY + amplitudeMm * Math.sin(t) * Math.cos(t)
    lines.push(`G1 X${x.toFixed(2)} Y${y.toFixed(2)} Z${z.toFixed(2)} F${feedrate}`)
  }
  return lines.join('\n')
}

function buildAxisLayer(
  axis: 'X' | 'Y' | 'Z',
  layerIndex: number,
  bounds: Bounds3D,
  opts: { sweepDurationMs: number; feedrate: number; danceAmplitudeMm: number },
): string {
  const centerX = (bounds.x.min + bounds.x.max) / 2
  const centerY = (bounds.y.min + bounds.y.max) / 2
  const axisBounds = axis === 'X' ? bounds.x : axis === 'Y' ? bounds.y : bounds.z
  const danceZ = axis === 'Z' ? bounds.z.max * 0.5 : bounds.z.min + 10 // 暫定値、要検証

  return [
    ';LAYER_CHANGE',
    `;Z:${layerIndex}`,
    ';HEIGHT:1',
    axisSweep(axis, opts.sweepDurationMs, Math.min(50, axisBounds.max - axisBounds.min), opts.feedrate, axisBounds),
    figureEightDance(centerX, centerY, danceZ, opts.danceAmplitudeMm, opts.feedrate),
  ].join('\n')
}

function buildDryRehearsalGcode(
  bounds: Bounds3D,
  opts: { sweepDurationMs: number; feedrate: number; danceAmplitudeMm: number },
): string {
  const lines = ['G28 ; home all axes', 'G90 ; absolute positioning']
  ;(['X', 'Y', 'Z'] as const).forEach((axis, i) => {
    lines.push(buildAxisLayer(axis, i + 1, bounds, opts))
  })
  lines.push('M84 ; disable motors')
  return lines.join('\n')
}
```

## 9. プレート交換シーケンスの末尾挿入

**テスト軌道のG-code自体にはswap gcodeを含めない。** 軸スイープ／8の字ダンス(3〜5章)は
純粋な移動テストであり、swapシーケンスを混ぜない。その代わり、**ドライリハーサルを実行すると
最後に一度だけプレート交換が起きる**よう、軌道の後・`M84`の前にswapシーケンスを追記する。
これにより「swap機構起動用G-codeの挿入」自体も同時に検証できる（実プリントで末尾に交換を注入する
パイプライン＝本体 7章 `injectEndSequence` と同じ追記機構）。

- swapシーケンスはサーバ側プロファイル(本体 7章)から取得し、`{name}` 等を解決してから追記する。
- 追記ブロックは `; DRY_SWAP_BEGIN 1` / `; DRY_SWAP_END 1` で囲む(計測・進捗検出・回数検証用)。
- **swapブロックは可動域クランプ(5章)の対象外**。交換は意図的にヘッドを通常域外へ動かす
  (例 `G1 Z180`)ため、軌道部分だけをクランプ対象とする(INV-DRY-04)。
- swapシーケンス未指定なら追記しない(純粋な軸テストとして使える)。

```
… 軸レイヤー(X/Y/Z) …
; DRY_SWAP_BEGIN 1
G1 Z180 F3000   ; …swap sequence（プロファイル由来、クランプしない）…
; DRY_SWAP_END 1
M84
```

実装は `buildDryRehearsalGcode(bounds, { …, swapSequence, swapVars })`(オプション)。
swapブロックにも加熱(M104等)・押出(E)は含めない(5章の安全要件は全体に適用、INV-DRY-01/02)。

## 10. 未解決・要検証事項

- [ ] 8の字ダンスの周期・振幅・feedrateの実測チューニング(現状はプレースホルダー値)
- [ ] `gcode_line`一括送信時の文字数/行数上限の確認
- [ ] 2025年1月以降ファームウェアの署名要件への対応方法確定
- [ ] Z軸レイヤーでの8の字ダンス実行高さの妥当性(実機振動特性次第で変更の可能性あり)
- [ ] `;LAYER_CHANGE`マーカーを用いたブラウザ可視化との統合テスト
- [ ] 採用するG-codeビューアライブラリでの非押出移動表示オプション名・挙動の実機確認(バージョン差異あり)
