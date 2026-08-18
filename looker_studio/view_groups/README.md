# suffix 違い View のロジック グループ比較

`INFORMATION_SCHEMA` から取った View の DDL を、**suffix を除いた base 名ごとに束ね、
SQL ロジックが同じもの同士でグループ化**する。グループ内の差分はパラメータ化して
消すので、グループ間の比較には**ロジックの差だけが残る**。

```
v_daily_sales_abjp … v_daily_sales_efuk （9 本）
        ↓ suffix 抽出   {ab,cd,ef} x {jp,us,uk}
  base = v_daily_sales / suffix = abjp …
        ↓ ロジックでグループ化（α 等価）
  [abjp, abuk, abus]   [cdjp, cduk, cdus]   [efjp, efuk, efus]
        ↓ グループ内の差を {{P1}} … に置換
  パラメータ化 SQL 3 本
        ↓
  Looker Studio にタブで表示
    全体タイトル : v_daily_sales
    ペイン見出し : "abjp, abuk, abus" など
```

## 「同じロジック」の判定

**α 等価**で判定する。トークン列が同じ長さ・同じ種類で並び、異なる箇所が
**一貫した 1 対 1 対応（全単射）**になっていれば同一ロジックとみなす。

suffix の文字列置換に依存しないので、**参照テーブル以外が異なっていても揃う**。
サンプルでは国ごとにデータセット名が変わる（`sample_src_apac` / `_amer` / `_emea`）が、
同じグループにまとまる。

α 等価は推移的（全単射の合成）なので、グループ判定は代表 1 本との比較で足りる。

### 取得元は VIEWS.view_definition を使う

`INFORMATION_SCHEMA.TABLES.ddl` は BigQuery が組み立てた `CREATE VIEW` 文で、
**`OPTIONS` に description や作成タイムスタンプが自動で入る**。View ごとに値が
違うので、そのまま比較すると全部が別グループに割れる（9 View なら 9 グループ）。

`INFORMATION_SCHEMA.VIEWS.view_definition` はクエリ本体だけを返すので、
ヘッダも `OPTIONS` も付いてこない。View 自身の名前も入らないため、
パラメータには**参照先の差だけ**が残る。`build_table.sql` はこちらを使う。

### 比較の前に落とすもの

`TABLES.ddl` を使う場合に備えて、**`OPTIONS( … )` 句は既定で無視する。** BigQuery が返す DDL には `description` や
作成タイムスタンプが `OPTIONS` に入る。これはメタデータであってロジックでは
ないのに View ごとに値が違うため、そのままだと全部が別グループに割れる。
ビュー側を書き換えるのではなく解析側で無視する。

正規表現ではなくトークン列で処理しているので、`OPTIONS` の値に括弧や引用符が
入っていても対応する `)` を正しく見つける。`stripOptions: false` で無効化できる。

### 効きすぎないようにしていること

この判定は強力なので、放っておくと本物のロジック差まで同一視しかねない。

- **置換可能なのは識別子とバッククォート識別子だけ**。予約語や記号の差はロジック差
- **リテラル差は既定でロジック差として残す**。`WHERE x = 1` と `WHERE x = 2` は別グループ。
  同一視したい場合だけ `substitutable` に `number` / `string` を足す
- **何をパラメータとみなしたかを必ず `params` で返す**。判定が正しいかを人が確認できる。
  ここを隠すと危ないので、画面にも出す前提

## suffix の抽出

3 通りの指定方法があり、上から優先される。

| 指定 | 用途 |
|---|---|
| `suffixParts: [['ab','cd','ef'], ['jp','us','uk']]` | **区分の組み合わせ**。規則が最もはっきりする。内訳（`parts: ['ab','jp']`）も返る |
| `suffixList: ['abjp', 'abus', …]` | 既知の一覧を直接指定 |
| `suffixPattern: '^(.*?)_([A-Za-z0-9]{1,6})$'` | 正規表現。既定は末尾の `_` + 1〜6 文字 |

`v_daily_sales` のように suffix を持たない名前は対象外（`unmatched` に入る）。

## 検証用サンプル

BigQuery に実データを作って試せる。

```bash
node build_sample_sql.mjs   # sample_data.sql / sample_teardown.sql を生成
node test.mjs               # アナライザの検証（25 アサーション）
```

| ファイル | 内容 |
|---|---|
| `sample_data.sql` | データセット 4 つ・ソース テーブル 18 本・View 9 本を作る |
| `sample_teardown.sql` | 片付け（データセットごと DROP） |
| `sample_views.js` | サンプルの定義。**SQL 生成とテストが同じものを参照する** |

`PROJECT` を自分のプロジェクト ID に置換して実行する。
ロケーションは `asia-northeast1` にしてあるので、必要なら書き換える。

サンプルの構成:

- suffix は `{ab, cd, ef} × {jp, us, uk}` の 4 文字（9 通り）
- 前 2 桁が SQL ロジックの系統（＝期待するグループ）
- 後 2 桁が国。**参照先のデータセットとテーブル名の両方**が変わるので、
  「suffix 文字列と一致しない差」も含んでいる
- ロジックは 3 系統
  - `ab` 素の集計
  - `cd` `customers` を結合して region を取り直す
  - `ef` 通貨で切って平均を足す

作成後、アナライザに渡す入力はこれで取れる。

```sql
SELECT table_name AS view_name, view_definition AS ddl
FROM `PROJECT.sample_mart.INFORMATION_SCHEMA.VIEWS`
ORDER BY table_name;
```

## 副産物

**グループ数が 1 なら「全 suffix が同一ロジック＝正常」**という健全性チェックになる。
グループが増えていれば、意図しない差異が入った疑いとして検知できる。

## 表示（render_groups.js）

`analyze()` の結果 1 base 分を HTML にする。`preview.mjs` で描き分けを確認できる。

| グループ数 | 既定のレイアウト |
|---|---|
| 1 | 差分なしの案内 |
| 2 | 2 ペイン（比較が 1 通りしかないのでタブにしない） |
| 3 以上 | 最大グループを基準に、比較相手を**タブ**で切り替える |

`layout: 'panes'` を渡せば 3 ペイン横並びにも戻せる（`'tabs'` で常にタブ）。

タブは **radio + `:checked` の CSS のみ**で動く（Templated Record では JavaScript が
使えないため）。CSS セレクタは ID ではなくクラスで書いてあるので、CSS を静的に保てる。
`MAX_TABS = 12` まで規則を用意し、超過分は件数を明示して切り捨てる。

ペイン副題は View 数（`基準 / 3 View`）。ベンダリングした `render.js` は
`(after)` / `(reference)` を出すが、ロジック系統の間に時間的な前後関係も優劣も
ないため誤解を招く。`render.js` は書き換えず、出力側で置換している。

**何をパラメータ化したかの一覧を常時添付**する（折りたたみ）。α 等価の判定は
強力なので、当否を人が確認できるようにしておく。

```bash
node preview.mjs          # dist/preview.html を生成して検証（19 アサーション）
node preview.mjs --check  # 生成せず検証だけ
```

## BigQuery UDF（view_group_html.sql）

```bash
node build_udf.mjs          # 検証して view_group_html.sql を生成
node build_udf.mjs --check  # 生成せず検証だけ（21 アサーション）
```

| 関数 | 戻り値 |
|---|---|
| `VIEW_GROUP_INFO(views, options_json)` | `STRUCT<view_count, group_count, group_labels, group_sizes, suffixes, unmatched_count, html>` |
| `VIEW_GROUP_CSS(options_json)` | `mode='class'` でテンプレートに貼る CSS |

HTML とメタデータを 1 回の呼び出しで返すのは、事前生成テーブルに両方入れたいため。
分けると同じ解析を 2 回走らせることになる。数値が `FLOAT64` なのは JS UDF が
`INT64` を扱えないから（SQL 側で `CAST`）。

**インラインのコード ブロブは 32 KB までに制限される（標準 SQL でも同じ）。**
素の連結は約 45 KB あって確実に弾かれるので、esbuild で最小化してから埋め込む。

```
VIEW_GROUP_INFO  素 46.0 KB → 最小化 28.1 KB（上限比 94%）
VIEW_GROUP_CSS   素 45.8 KB → 最小化 27.7 KB（上限比 92%）
```

> **枠がほぼ埋まっている。** 次に機能を足すときは
> `OPTIONS(library=["gs://…"])` への移行が必要。逃げ道として、
> `layout:'panes'` を捨てて 3 ペイン描画（`renderFragment3` / `build3Way` /
> `mapToBase`）を外せば数 KB 空く。

生成時に 30 KB を超えたら失敗させ、BigQuery に弾かれるものを出荷しない。
最小化した本体はそのまま Node で実行して検証しているので、最小化で壊れていない
ことも毎回確認できる。将来この枠に収まらなくなったら
`OPTIONS(library=["gs://…"])` に切り替える（BigQuery はジョブの認証情報で読むので
**非公開バケットで構わない**）。

> esbuild の `transformSync` に `format` を渡すとラップされて未使用のトップレベル
> 関数が落ちる（45 KB が 5.6 KB になり関数が消える）。`format` は指定しないこと。

## 事前生成テーブル（build_table.sql）

Looker の操作のたびに UDF を回すのは重いので、スケジュールドクエリで作り置きする。
`INFORMATION_SCHEMA` の中身は View をデプロイしたときしか変わらない。

```
view_logic_diff  PARTITION BY snapshot_date CLUSTER BY base
  base / view_count / group_count / has_multiple
  group_labels / group_sizes / suffixes / unmatched_count / diff_html
```

Looker Studio は `v_view_logic_diff_latest` を読むだけ。`base` をプルダウンにして
`diff_html` を Templated Record に渡す。パラメータもカスタムクエリも UDF も不要。

パーティションに日付を積むので**履歴が残る**。「いつグループ構成が変わったか」を
後から追えるので、ロジック逸脱の検知に使える（`build_table.sql` の末尾に例あり）。

> `build_table.sql` の `REGEXP_EXTRACT` と UDF の `suffixParts` は**必ず揃える**こと。
> ズレると base の束ね方と UDF の解析が食い違う。

## Looker Studio への配線

事前生成テーブルができていれば、あとは読むだけ。

1. **データを追加 → BigQuery** で `v_view_logic_diff_latest` を選ぶ
   （カスタムクエリではなくテーブル選択でよい）
2. **Templated Record** を配置し、表示対象のカラムに `diff_html` を指定
3. **コントロール → プルダウン リスト**を置き、コントロール フィールドに `base`。
   **「単一選択にする」をオン**（1 レコード＝1 base を表示するため）
4. `mode='class'` で生成した場合は、テンプレートに CSS を貼る

CSS は **`template_style.html`**（`build_udf.mjs` の生成物）をそのまま貼るか、
BigQuery から取る。中身は同じ。

```sql
SELECT `PROJECT.DATASET.VIEW_GROUP_CSS`(
  '{"suffixParts": [["ab","cd","ef"],["jp","us","uk"]]}'
);
```

`<style> … </style>` で囲んでテンプレートの先頭に置き、その下に
`diff_html` のフィールドを差し込む。

> **`templated_record/samples/04_template_style.html` は使えない。**
> あちらは 2 者比較用の `DIFF_CSS` の出力で、見出し・タブ・パラメータ表の
> `.vg-*` 規則を含まないため、タブが動かない。

補助として、`has_multiple` でフィルタした表を並べると「要確認の base」の一覧になる。

### 確認クエリ

配線の前に、テーブルの中身が期待どおりか見ておく。

```sql
SELECT base, view_count, group_count, group_labels, unmatched_count,
       LENGTH(diff_html) AS html_len
FROM `PROJECT.DATASET.v_view_logic_diff_latest`
ORDER BY base;
```

サンプルなら `v_daily_sales / 9 / 3 / [abjp, abuk, abus | …] / 0` になる。

> `group_count` が想定より多い場合は、BigQuery が返す DDL が投入したテキストと
> 違う（整形が正規化される、`OPTIONS` が付く等）可能性がある。
> `diff_html` を見れば何が差分として残ったか分かる。
