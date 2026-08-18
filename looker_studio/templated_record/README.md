# Templated Record + BigQuery で DDL 差分を表示する

**公開 GCS バケットを一切使わずに、GitHub compare と同等の差分表示ができる構成。**

[Templated Record](https://lookerstudio.google.com/reporting/fd0db9a6-2d6b-443a-adbc-f6a7c7a285a7/page/GUgQB)
は Looker Studio のギャラリーに掲載されているコミュニティ ビジュアライゼーションで、
**1 行のデータを HTML / CSS で自由に表現する**チャート。ギャラリー掲載品なので
**公開元がホストしており、こちらでバケットを公開する必要がない。**

カラムに HTML ソースを入れて表示対象に指定すると、そのまま HTML / CSS として
解釈されて描画されることを実機で確認済み。

## 構成

```
BigQuery                                  Looker Studio
────────────────────────────────────      ──────────────────────────
(key, ddl) の 2 列
        ↓
DIFF_HTML(before, after, …)  ← JS UDF     Templated Record
  lib/diff.js   LCS 行差分 + 単語差分      テンプレート = DIFF_CSS() の <style>
  lib/render.js HTML を生成                 表示対象カラム = diff_html
        ↓                                          ↓
1 行 1 カラムの HTML 文字列                そのまま HTML として描画
```

**HTML の生成を BigQuery 側に寄せる**のがこの構成の要点。ビジュアライゼーション側は
第三者製の汎用チャートのままで、差分ロジックは自分たちの管理下に残る。

## 手順

### 1. UDF を作る

[`ddl_diff_html.sql`](./ddl_diff_html.sql) を BigQuery で実行する（`PROJECT.DATASET` は置換）。
GCS もライブラリ参照も不要な、単体で完結した `CREATE FUNCTION` 文。

### 2. データを用意する

`(key, ddl)` の 2 列を持つビュー。作り方は [`../ddl_diff.sql`](../ddl_diff.sql) のセクション 0-2。

### 3. Looker Studio に繋ぐ

[`query.sql`](./query.sql) に 2 パターン用意してある。

- **A: レポート上で key を 2 つ選ぶ** — カスタムクエリ + パラメータ 2 つ
- **B: 比較軸が固定** — 例「同じ View の連続する 2 スナップショット」を VIEW で用意し、
  Templated Record 側で View 名を 1 つに絞る。パラメータの候補リストを保守しなくて
  済むので運用は楽

Templated Record を配置し、**表示対象のカラムに `diff_html` を指定**する。

## オプション

`DIFF_HTML` の第 5 引数に JSON を渡す。`NULL` または `'{}'` で既定。

| キー | 既定 | 内容 |
|---|---|---|
| `mode` | `inline` | `inline` すべてインライン CSS・単体で完結／`class` markup のみ（CSS は `DIFF_CSS()` をテンプレートに貼る。**最小**）／`embed` `<style>` 同梱の自己完結版 |
| `contextLines` | なし（全行） | 変更行の前後 N 行だけ描画する |
| `fontSize` / `lineHeight` | 12 / 1.35 | |
| `colors.baseColor` / `colors.afterColor` | `#E17B7B` / `#93AE68` | 差分行・差分文字・カラーバー・ヘッダが連動 |
| `diffLineOpacity` / `diffCharOpacity` | 0.30 / 0.55 | |
| `syntax.keyword` / `.literal` / `.comment` | `#CF222E` / `#098658` / `#6E7781` | |

```sql
DIFF_HTML(before_ddl, after_ddl, 'v1', 'v2', '{"mode":"class","contextLines":3}')
```

`mode='class'` のときは、テンプレートに貼る CSS を `DIFF_CSS()` で取る。

```sql
SELECT `PROJECT.DATASET.DIFF_CSS`(NULL);
```

出力を `<style> … </style>` で囲んでテンプレートに貼る。**色やフォントを変えた場合は、
`DIFF_CSS()` にも同じ `options_json` を渡して CSS を作り直すこと。**

## サイズ対策：CSS をテンプレートに分離する

インライン CSS の HTML は元の DDL の約 21 倍に膨らむ。Templated Record は
`<style>` が使えるので、**CSS をテンプレート側に固定で置き、カラムには markup だけ
載せる**（`mode='class'`）と、カラムに載る文字列が約半分になる。

`node build_samples.mjs` の実測（カラムに載る文字列）:

| DDL 行数 | `inline` | `embed` | `class` | class の削減 |
|---:|---:|---:|---:|---:|
| 50 | 54 KB | 27 KB | 25 KB | 54% |
| 200 | 201 KB | 96 KB | 94 KB | 53% |
| 500 | 497 KB | 235 KB | 233 KB | 53% |
| 1000 | 991 KB | 467 KB | 465 KB | 53% |

`DIFF_CSS()` は 26 規則・約 3KB で**固定長**。テンプレートに 1 回貼るだけで、
差分の内容が変わっても書き換え不要。

`embed` は `class` とほぼ同じ大きさで、しかも自己完結する（テンプレートを触らなくてよい）。
テンプレート編集を避けたいなら `embed`、最小にしたいなら `class`。

**3 モードとも見た目は同一。** 実ブラウザで描画してスクリーンショットが
バイト単位で完全一致することを確認済み。

クラス名は `style` 属性の中身のハッシュから決めているので、**内容や出現順に依存せず、
同じ宣言には必ず同じクラス名が付く**。これがないとテンプレート側の固定 CSS と
markup 側のクラス名がズレる。`DIFF_CSS()` は markup と同じコードから CSS を作るので、
両者が食い違うことはない。

さらに小さくしたいときは `contextLines` を併用する。

### 検証用サンプル

[`samples/`](./samples/) に生成済み（`node build_samples.mjs` で再生成）。
中身は **UDF 本体を実行して得た文字列そのもの**なので、BigQuery が返すものと一致する。

| ファイル | 用途 |
|---|---|
| `01_style_test.html` | `<style>` と子要素セレクタが効くかだけを見る最小サンプル |
| `02_diff_inline.html` | `mode='inline'` の出力 |
| `03_diff_classed.html` | `mode='class'` + `DIFF_CSS()`（単体で表示可能） |
| `04_template_style.html` | **テンプレートに貼る CSS**（`DIFF_CSS(NULL)` の出力） |
| `05_column_markup.html` | **カラムに入る markup**（`mode='class'` の出力） |
| `06_diff_embed.html` | `mode='embed'` の出力 |

## 制約

- **行内の単語単位ハイライトは効く**（`wordDiff` がそのまま動く）。
  表グラフ方式では再現できなかった部分がここでは出る
- LCS は O(旧行数 × 新行数)。約 2000 行 × 2000 行を超えると差分計算を中止して
  案内 HTML を返す
- UDF は呼び出しのたびに走る。VIEW のままだと Looker Studio の操作ごとに
  再計算されるので、比較軸が固定なら**スケジュールドクエリでテーブル化**する
- Templated Record は第三者製。コミュニティ ビジュアライゼーションは sandbox iframe 内で
  外部ネットワークにアクセスできないため DDL が外部送信されることはないが、
  第三者コードを通すこと自体の可否は組織で確認すること

## 再生成

`ddl_diff_html.sql` は生成物。直接編集しない。

```bash
node build_udf.mjs          # 検証して ddl_diff_html.sql を生成
node build_udf.mjs --check  # 生成せず検証だけ
node build_samples.mjs      # samples/ を再生成し、サイズを実測
```

元コードは `diff_html/` の VS Code 拡張の `lib/diff.js` / `lib/render.js`
（実体は [`../ddl_diff_viz/src/lib/`](../ddl_diff_viz/src/lib/) にベンダリング済み）。
拡張側を更新したらそちらを差し替えてから再生成する。

`build_udf.mjs` は生成した UDF 本体を **Node 上で実際に実行して検証**する
（11 アサーション）。BigQuery に上げる前に、差分 HTML が出るか・`contextLines` が効くか・
壊れた JSON や空入力で落ちないかまで確認できる。
