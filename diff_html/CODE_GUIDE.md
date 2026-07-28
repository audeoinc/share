# コード解説 — Export to Diff HTML

この拡張の JavaScript を理解・改修するためのガイドです。依存ライブラリはゼロ、ビルド不要のプレーン JS（CommonJS）で書かれています。

---

## 1. 全体構成とデータの流れ

```
export-to-diff-html/
├─ extension.js   … VS Code との接続層（コマンド登録・ファイル読込・Webview・コピー）
├─ lib/
│  ├─ diff.js     … 差分計算（純粋ロジック。VS Codeに依存しない）
│  └─ render.js   … 差分データ → HTMLフラグメント生成（色・レイアウト）
├─ test/diff.test.js … diff.js のユニットテスト（node:test）
└─ samples/       … 動作確認用サンプルSQL
```

処理の流れは一方向です。

```
右クリック
  → extension.js: 選択ファイルを読み込み、行配列にする
    → diff.js: build2Way / build3Way で「差分データ（行の配列）」を作る
      → render.js: renderFragment2 / renderFragment3 で HTML文字列にする
        → extension.js: Webview に表示、コピー時はその文字列をクリップボードへ
```

役割分担のポイント:
- **diff.js は「何が差分か」だけを決める**（色や見た目は一切知らない）。
- **render.js は「どう見せるか」だけを決める**（差分の意味は diff.js の出力を信じる）。
- **extension.js は VS Code とのつなぎ**（ロジックは持たない）。

この分離のおかげで、色を変えたいときは render.js だけ、差分の取り方を変えたいときは diff.js だけを触れば済みます。

---

## 2. diff.js — 差分計算

### 2.1 行単位の差分：`diffLines(a, b)`

2つの行配列 `a`, `b` を比較し、**LCS（最長共通部分列）** に基づいて操作列を返します。

```js
// 返り値の例（type は equal / del / add）
[{type:'equal', aIndex, bIndex, text}, {type:'del', aIndex, text}, {type:'add', bIndex, text}, ...]
```

仕組み:
1. `dp[i][j]` に「a[i..] と b[j..] の LCS 長」を動的計画法で埋める（`O(n*m)`）。
2. 先頭から辿り、`a[i]===b[j]` なら equal、そうでなければ dp の大小で del か add を選ぶ。

`equal`＝両方にある行、`del`＝a だけにある行、`add`＝b だけにある行、です。この時点では「変更」という概念はまだありません（変更は del+add として現れる）。

### 2.2 行内（文字単位）の差分：`wordDiff(oldStr, newStr)`

変更行のどの文字が変わったかを求めます。行を **トークン（語 / 空白 / 記号）** に分割し、トークン単位で LCS を取り、`oldSegs` / `newSegs`（`{text, hi}` の配列。`hi:true` が変更箇所）を返します。

```js
tokenize("u.name")      // → ["u", ".", "name"]
wordDiff("u.name","u.id") // 変わった "name"/"id" 側だけ hi:true
```

`mergeSegs` は隣り合う同じ `hi` のトークンを結合して、無駄な span を減らします。

### 2.3 サイドバイサイド行：`build2Way(aLines, bLines)`

`diffLines` の結果を、左右に並ぶ**行データ**へ変換します。ポイントは **del の連続と add の連続を突き合わせて「変更(mod)」にまとめる**ことです。

```js
// 各 row は { type:'equal'|'mod'|'add'|'del', left, right }
//   left/right: { num(行番号), segs, kind:'plain'|'add'|'del' } | null(=相手なし)
```

ロジック:
- `equal` はそのまま左右同じ行。
- `del` の並びと直後の `add` の並びをためて、位置ごとにペア:
  - 両方あり → `mod`（`wordDiff` で行内ハイライト）
  - del だけ → `del`（右は null）
  - add だけ → `add`（左は null）

この「連続 del ＋連続 add をペアにする」処理が、一般的な差分ツールの「変更行」表示に相当します。

### 2.4 3ファイル：`build3Way(base, after, ref)`

基準を左端 `base` に固定し、`after` と `ref` を base に対応づけて3列を作ります。

補助関数:
- `mapToBase(base, other)` … **`build2Way` を再利用**して、base の各行に対する other 側の状態を作る。
  - `of[b]` = `{text, changed}`（equal/mod）/ `null`（other で削除）
  - `inserts` = other 側だけにある行（アンカー位置ごと）
  - ※ 以前は独自ロジックで対応付けていたが、行がズレる不具合があったため、正しくペアリングできている `build2Way` を土台にしている。
- `baseCell(baseText, aOf, rOf)` … base 行のセルを作る。**after / reference のどちらかと異なるトークンを行内ハイライト**する（before/after が主軸なので after を優先、ref のみの差分も拾う）。一致判定は `lcsMatchFlags`。
- `otherCell(m, b)` … after / ref のセル。`changed` なら `wordDiff` の `newSegs` でハイライト、未対応なら空セル。

各 base 行について、まず「base より前に挿入された other 専用行」を出し、その後 base 行本体（c1=base, c2=after, c3=ref）を出します。

`kind` の意味:
- `base` … 差分なしの base 行
- `diff` … after/ref に差分がある base 行（背景＋行内ハイライト）
- `plain` … 変更なしの after/ref セル
- `add` … 変更/挿入された after/ref セル
- `empty` … その列に対応行がない（斜線ハッチ）

### 2.5 補助：`splitLines(text)`

テキストを行配列へ。末尾の余分な空行を1つ除去します（ファイル末尾改行対策）。

---

## 3. render.js — HTML 生成

差分データを、**`<div>` ルート＋インライン CSS の HTML フラグメント**（Confluence 貼り付け用）にします。`<html>/<body>` は含めません。

### 3.1 色・見た目の設定（ここを触れば配色が変わる）

```js
const T = { ... }      // 共通トークン（本文色・枠線・影・行間・斜線ハッチ 等）
const PANES = {         // ペイン別アクセント
  base:  { bg, hi, bar, mark, numBg, headText, headBg }, // 赤
  after: { ... },                                        // 緑
  ref:   { ... },                                        // 青
}
const S = { keyword, literal, comment } // SQL シンタックス色
```

- `bg` = 差分行の背景、`hi` = 差分文字（行内ハイライト）の背景、`bar` = 左のカラーバー、`mark` = +/− の色、`numBg` = 行番号列の淡いティント。
- **配色を変えたいときはこの3つのオブジェクトだけ**を編集すればOKです。
- 行間は `T` を使う `wrapTable` 内の `line-height`（現在 1.35）。

### 3.2 SQL シンタックスハイライト：`sqlHighlight(src)`

1行を先頭から走査し、コメント（`--`）・文字列（`'...'`）・数値・予約語を、それぞれ色付き `<span>` にします。予約語は `SQL_KEYWORDS`（Set）で判定。識別子・関数・演算子は本文色のまま。

- **予約語を足したい**ときは `SQL_KEYWORDS` に単語を追加。
- HTML特殊文字は `esc()` でエスケープ。

### 3.3 セル生成のヘルパー

- `renderSegs(segs, hiColor)` … `{text,hi}` の配列を、`sqlHighlight` をかけつつ、`hi:true` の部分だけ背景 span で包む。**シンタックス色（前景）と差分ハイライト（背景）を重ねる**のがポイント。
- `numTd` / `markTd` / `codeTd` … 行番号 / マーカー / コード のセル。`codeTd` は `white-space:pre-wrap`（インデント保持のまま折り返し）。
- `hatchTd` … 空きセルの斜線ハッチ（`repeating-linear-gradient`）。
- `th` … ヘッダ。ファイル名は黒（`T.title`）、サブラベル（before/after…）はペイン色。

### 3.4 テーブル全体：`wrapTable(colgroup, thead, body)`

- `table-layout:fixed; width:100%` ＋ `<colgroup>` で**各ペインを等幅**にする（内容が長くても列幅が偏らない）。
- `-webkit-text-size-adjust:100%` 等で**モバイルの自動フォント拡大を無効化**（幅の広い列だけ文字が大きくなる現象の対策）。

### 3.5 出力の入口

- `renderFragment2(leftLabel, rightLabel, rows)` … 2ファイル（左=base/赤, 右=after/緑）。列は `[行番号, マーカー, コード]`×2。
- `renderFragment3(labels, rows)` … 3ファイル（base/赤, after/緑, ref/青）。列は `[行番号, コード]`×3。行番号カウンタは列ごとに独立。

---

## 4. extension.js — VS Code 連携

### 4.1 起動と登録

`activate()` で `exportToDiffHtml.export` コマンドを登録。`package.json` の `contributes.menus['explorer/context']` により、エクスプローラー右クリックに「Export to Diff HTML」が出ます（`when: explorerResourceIsFolder == false`）。

### 4.2 コマンド本体：`exportCommand(clickedUri, selectedUris)`

1. `pickUris` で選択ファイル群を取得（複数選択は `selectedUris`）。
2. **2個 or 3個以外はエラー**：`「2または3 個のファイルを選択してください」`。
3. `vscode.workspace.fs.readFile` で読み込み → `splitLines` で行配列に。
4. 2個なら `renderFragment2`、3個なら `renderFragment3` でフラグメント生成（選択順に左から）。
5. `createWebviewPanel` でパネルを開き、`webviewHtml` を表示。
6. Webview から `copy` メッセージが来たら `vscode.env.clipboard.writeText(fragment)` でコピー。

**HTML ファイルは保存しません**（メモリと Webview 上だけ。git に影響しない）。

### 4.3 Webview：`webviewHtml(webview, fragment)`

- 左ペイン＝ソース（`<pre>` にエスケープ表示）＋コピーアイコン、右ペイン＝プレビュー（フラグメントをそのまま描画）。
- 仕切りはドラッグで幅可変。コピー時に画面下へ**トースト**を表示。
- CSP（Content-Security-Policy）を設定し、スクリプトは nonce 付きのみ許可。ページの chrome は VS Code のテーマ変数（`--vscode-*`）で配色。

---

## 5. よくある改修ポイント

| やりたいこと | 触る場所 |
|--------------|----------|
| ペインの色を変える | `render.js` の `PANES`（bg=差分行 / hi=差分文字） |
| 予約語・リテラルの色 | `render.js` の `S` |
| 予約語を追加 | `render.js` の `SQL_KEYWORDS` |
| 行間を変える | `render.js` `wrapTable` の `line-height` |
| メニュー名/エラー文言 | `extension.js`（`showErrorMessage`）/ `package.json`（command title） |
| 差分の取り方（3-way基準など） | `diff.js` の `build3Way` / `baseCell` |
| コピー時の挙動 | `extension.js` の `onDidReceiveMessage` |

改修したら `node --test`（差分ロジックのテスト）を実行してから配布してください。

---

## 6. テストとパッケージング

- テスト: `node --test`（依存ゼロ / Node 標準）。`test/diff.test.js` が diff.js を検証。
- VSIX 化: `npx @vscode/vsce package`（Node が必要）。または JS を `~/.vscode/extensions/` に直接配置。
- 配布: 生成物を社内 Git へ手動アップロード。
