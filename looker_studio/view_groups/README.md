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
SELECT table_name AS view_name, ddl
FROM `PROJECT.sample_mart.INFORMATION_SCHEMA.TABLES`
WHERE table_type = 'VIEW'
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

## 未実装

- BigQuery UDF 化（`templated_record/build_udf.mjs` と同じ生成方式）
- `INFORMATION_SCHEMA` から事前生成テーブルを作る SQL
- Looker Studio への配線
