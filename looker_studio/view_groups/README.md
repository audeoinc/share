# suffix 違い View のロジック グループ比較

`INFORMATION_SCHEMA` から取った View の DDL を、**suffix を除いた base 名ごとに束ね、
SQL ロジックが同じもの同士でグループ化**する。グループ内の差分はパラメータ化して
消すので、グループ間の比較には**ロジックの差だけが残る**。

```
v_daily_sales_abjp … v_daily_sales_efuk （9 本）
        ↓ suffix 抽出   データセット名の末尾から自動で拾う
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

### 比較の前に suffix を伏せ字にする（suffixAware・既定 on）

suffix はいろいろな場所に現れる。データセット名（`mart_abjp`）、テーブル名
（`orders_abjp`）、リテラル（`'abjp' AS region`）。識別子の差は α 等価が吸収するが、
**リテラルの差は既定でロジック差として残す**ので、suffix 入りのリテラルがあると
「本当は同じロジックなのに 9 本が 9 グループに割れる」ことになる。

そこで比較の直前に、**その View 自身の suffix をトークン内で伏せ字**にする。
suffix 由来の差は場所を問わず消え、**残った差＝本当のロジック差**になる。

```
v_x_abjp:  WHERE src = 'load_abjp'  →  WHERE src = 'load_␀'   ┐ 同じ
v_x_abus:  WHERE src = 'load_abus'  →  WHERE src = 'load_␀'   ┘
v_y_abjp:  WHERE status = 'A'                                 ┐ 違う
v_y_cdjp:  WHERE status = 'B'                                 ┘
```

`substitutable` に `string` を足すのとは違う。あちらは**すべての**リテラル差を
同一視してしまうので、`'A'` と `'B'` のロジック差まで消える。伏せ字は suffix に
一致する部分だけを対象にするので、そこが残る。

伏せ字は比較用のトークン列にだけ効く。パラメータ化と表示は元のテキストを使うので、
`{{P1}}` の値には `orders_abjp` / `orders_abus` がそのまま並ぶ。

`suffixAware: false` で無効化できる。

#### リテラルは値がまるごと一致したときだけ照合する

リテラルには `'abjp'` そのものではなく、**suffix と連動した別表記**が入ることが多い。

```sql
WHERE country = 'JP'   -- v_x_abjp
WHERE country = 'US'   -- v_x_abus
```

これは文字列としての suffix と一致しないので、上の伏せ字だけでは吸収できず、
リテラル差＝ロジック差として別グループに割れてしまう。

そこで**リテラルの値そのもの**を、その View の**suffix 語彙**と照合する。
語彙は suffix 自身とその区分（`abjp` なら `ab` / `jp`）で、大文字小文字は無視する。

- **引用符の中身がまるごと一致したときだけ**置き換える。
  リテラルの中を語単位で探すと、`'ORDER_IN_TRANSIT'` の `IN` のような
  無関係な語まで拾ってしまう
- 対象は文字列リテラルと数値リテラルだけ。バッククォート識別子は
  `substitutable` が面倒を見るので触らない
- 区分は `suffixParts` があればそれ、なければ長さが偶数のときの前後半
- 照合するのは**その View 自身の**語彙だけ。`abus` の View に `'JP'` が
  書いてあれば吸収されず差として残る（＝取り違えを見逃さない）
- `'A'` と `'B'` のような連動しない値は従来どおりロジック差

なお、**完全な suffix は部分一致でも伏せ字にする**（`'load_abjp'` → `'load_␀'`、
`mart_abjp` → `mart_␀`）。4 文字そろっていれば無関係な一致はまず起きないため。
区分（2 文字）だけが完全一致を要求する。

`literalSuffixWords: false` で無効化できる。

#### suffix から導けない対応は手で並べる（literalGroups）

`'apac'` ↔ `'amer'` のように、**suffix とは別の語彙で連動している**値は
機械的には導けない。数が多くないのなら、並べて持つのが確実で見通しもよい。

```json
"literalGroups": [
  ["apac", "amer", "emea"],
  ["JPY", "USD", "GBP"]
]
```

- **1 つの配列が 1 つの同値類**。別の配列どうしは同一視しないので、
  `'apac'` と `'JPY'` が意図せず同じになることはない
- 照合は suffix 語彙と同じ規則。**文字列リテラルと数値リテラルの値そのもの**を
  大文字小文字を無視して見る。`'x_apac_y'` の `apac` は巻き込まない
- 1 段の配列（`["apac","amer"]`）も 1 組として受ける
- 数値も並べられる（`["1","2","3"]`）
- `suffixAware` とは独立に効く

並べていない値は従来どおりロジック差として残る。
**すべての**リテラル差を無視したいなら `substitutable` に `string` / `number` を
足すが、そちらは `'A'` と `'B'` の差も消える。

何を伏せ字にしたかは「なぜ別グループになったか」に
`⟨suffix⟩` / `⟨literalGroups[1]⟩` として出るので、効きすぎていないか確かめられる。

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
  例外は suffix と連動する値（下記）。同一視したい場合だけ `substitutable` に
  `number` / `string` を足す
- **何をパラメータとみなしたかを必ず `params` で返す**。判定が正しいかを人が確認できる。
  ここを隠すと危ないので、画面にも出す前提

## 設定は build_table.sql の DECLARE だけ

**設定ファイルは持たない。** 開発中に設定の置き場所が複数あると、期待どおりの
値でテストできているのかを毎回確かめる羽目になり、不具合の切り分けが遅くなる。
`build_table.sql` は生成物ではなく、**直接編集するファイル**。

`analyze.js` / `render_groups.js` から作るのは `view_group_html.sql`（UDF 本体）
だけで、そちらの設定も先頭の `DECLARE` にある。

| ファイル | 位置づけ |
|---|---|
| `build_table.sql` | 手で編集する。設定はセクション 0 の `DECLARE` |
| `view_group_html.sql` | `build_udf.mjs` の生成物。JS を最小化して埋めるため。設定は先頭の `DECLARE` |
| `template_style.html` | `build_udf.mjs` の生成物（CSS） |

## suffix はデータセット名から自動で拾う（既定）

suffix の一覧を人が書いて維持するのは、**View が増えたときに黙って壊れる**種類の
運用になる。幸い、**suffix として使われている文字列はデータセット名の末尾にも
現れる**（`mart_abjp` / `raw_cduk`）。ここから拾えば手運用が要らなくなる。

```sql
suffixes AS (
  SELECT suffix FROM UNNEST(
    IF(ARRAY_LENGTH(@suffix_list) > 0,
       @suffix_list,
       ARRAY(
         SELECT DISTINCT REGEXP_EXTRACT(schema_name, r'@@SUFFIX_PATTERN@@')
         FROM `@@PROJECT@@.region-@@REGION@@.INFORMATION_SCHEMA.SCHEMATA`
         WHERE REGEXP_CONTAINS(schema_name, r'@@SUFFIX_PATTERN@@')
           AND (@@SCHEMA_COND@@)
       ))
  ) AS suffix
),
```

この一覧を View 名との `ENDS_WITH` で突き合わせて base を切り、UDF に渡す
`suffixList` も同じ一覧から作る。**suffix が増えても SQL の修正は要らない。**

`REGEXP_EXTRACT` で base を切らないのは、**BigQuery の `REGEXP_*` がパターンに
定数を要求しうる**ため。実行時に決まる一覧から正規表現を組み立てるのは避けて、
`ENDS_WITH` の結合にしてある（複数一致したら長いほうを採る）。区切りの `_` は
SQL 側も UDF 側も固定なので、片方だけ変えると食い違う。

注意点:

- `region` は**データセットのロケーションと揃える**こと。`SET @@location` も
  同じ値にする。間違えるとセクション 0 の事前チェックで止まる
- **サンプルは View を 1 つのデータセット（`sample_mart`）にまとめてある**ので、
  自動検出では拾えない。`include_dataset_patterns = [r'^sample_mart$']` と
  `suffix_list = ['abjp', 'abuk', …]` を指定して試す
- **無関係なデータセットも条件に一致すれば拾われる**。害が出るのはその文字列で
  終わる View 名がある場合だけだが、気になるなら include / exclude で絞る

## 設定を変えたときにやること

```bash
# UDF の中身（analyze.js / render_groups.js）を変えたときだけ
node build_udf.mjs
```

そのあと BigQuery で:

1. `view_group_html.sql`（UDF を作り直した場合のみ）
2. `build_table.sql`
3. 表示に関わる設定（`mode` や色）を変えたら `template_style.html` も貼り直す

> UDF は `analyze_options` を実行時に受け取るので、**suffix 規則や
> `literalGroups` を変えるだけなら UDF の作り直しは不要**。
> `build_table.sql` の再実行だけでよい。

`analyze_options` に書けるキーは `view_group_html.sql` の冒頭に一覧がある。
綴りを間違えたキーは UDF 側で黙って無視されるので、効いていないと思ったら
まずそこを見る。

## suffix を認識できなかった View

**除外せず、単独の base として並べる**（`base` = View 名 / 1 View / 1 グループ）。
出さないとそのソースが画面から消えてしまい、**命名規則から外れた View ほど
気づけなくなる**。表示は 1 グループのときと同じで、見出しには suffix の代わりに
View 名が入り、`suffix 未認識` のバッジが付く。

`unmatched_count` は従来どおり件数を返すので、Looker 側で
`WHERE unmatched_count > 0` で拾える。`includeUnmatched: false` を渡すと
従来どおり除外できる。

`build_table.sql` 側も `COALESCE(<切り出した base>, view_name)` にしてあるので、
suffix の付かない View も 1 行として保存される。

## 検証用サンプル

BigQuery に実データを作って試せる。

```bash
node build_sample_sql.mjs   # sample_data.sql / sample_teardown.sql を生成
node test.mjs               # アナライザの検証（72 アサーション）
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

| グループ数 | レイアウト |
|---|---|
| 1 | 案内 ＋ **SQL 1 ペイン**（suffix 未認識の View もここ。単独で 1 View） |
| 2 | 2 ペイン（比較が 1 通りしかないので、タブ 1 枚は無駄） |
| 3 以上 | 最大グループを基準に、比較相手を**タブ**で切り替える |

**全 View が同一ロジックなら比較しない。** 同じ SQL を左右に並べても読む人が得る
ものが無いので、`renderFragment1` で 1 ペインだけ出す。差分の色分け（`+` / `−`
マーカー・行背景・ハッチ）は出番が無いので付かず、行番号と SQL だけになる。

**3 ペイン横並びは廃止。** 使わない方針にしたので、`build_udf.mjs` の `UNUSED` で
3-way 系の関数（`renderFragment3` / `build3Way` / `mapToBase` / `baseCell` /
`segsText`）ごと UDF から外している。インラインの 32 KB 枠がぎりぎりなので、
載せない分がそのまま余裕になる。

タブは **radio + `:checked` の CSS のみ**で動く（Templated Record では JavaScript が
使えないため）。CSS セレクタは ID ではなくクラスで書いてあるので、CSS を静的に保てる。
`MAX_TABS = 12` まで規則を用意し、超過分は件数を明示して切り捨てる。

ペイン副題は View 数（`基準 / 3 View`）。ベンダリングした `render.js` は
`(after)` / `(reference)` を出すが、ロジック系統の間に時間的な前後関係も優劣も
ないため誤解を招く。`render.js` は書き換えず、出力側で置換している。

**何をパラメータ化したかの一覧を常時添付**する（折りたたみ）。α 等価の判定は
強力なので、当否を人が確認できるようにしておく。

```bash
node preview.mjs          # dist/preview.html を生成して検証（32 アサーション）
node preview.mjs --check  # 生成せず検証だけ
```

## BigQuery UDF（view_group_html.sql）

```bash
node build_udf.mjs          # 検証して view_group_html.sql を生成
node build_udf.mjs --check  # 生成せず検証だけ（27 アサーション）
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
VIEW_GROUP_INFO  素 47.5 KB → 最小化 28.6 KB（上限比 95%）
VIEW_GROUP_CSS   素 47.3 KB → 最小化 28.3 KB（上限比 94%）
```

3-way 系と `alphaMap` を外しているが、**残りは 32 KB に対して 3.4 KB ほど**。
これ以上大きく機能を足すなら `OPTIONS(library=["gs://…"])` への移行を検討する。それでも枠は広くないので、
大きく機能を足すときは `OPTIONS(library=["gs://…"])` への移行を検討する。

生成時に 30 KB を超えたら失敗させ、BigQuery に弾かれるものを出荷しない。
最小化した本体はそのまま Node で実行して検証しているので、最小化で壊れていない
ことも毎回確認できる。将来この枠に収まらなくなったら
`OPTIONS(library=["gs://…"])` に切り替える（BigQuery はジョブの認証情報で読むので
**非公開バケットで構わない**）。

> esbuild の `transformSync` に `format` を渡すとラップされて未使用のトップレベル
> 関数が落ちる（45 KB が 5.6 KB になり関数が消える）。`format` は指定しないこと。

## 環境の指定はスクリプト変数（両ファイル共通）

`view_group_html.sql` も `build_table.sql` も、**先頭の `DECLARE` を書き換えるだけ**で
配置先が決まる。本文に置換は要らない。

```sql
-- view_group_html.sql
SET @@location = 'asia-northeast1';   -- DECLARE より前に置く

DECLARE project_id  STRING DEFAULT 'my-project';
DECLARE udf_dataset STRING DEFAULT 'ops_meta';

DECLARE system_name  STRING DEFAULT 'viewlgc';  -- build_table.sql と同じ値にする
DECLARE udf_prefix   STRING DEFAULT '';
DECLARE udf_suffix   STRING DEFAULT '';
DECLARE info_fn_base STRING DEFAULT 'VIEW_GROUP_INFO';
DECLARE css_fn_base  STRING DEFAULT 'VIEW_GROUP_CSS';

-- build_table.sql
SET @@location = 'asia-northeast1';   -- DECLARE より前。region と同じ値にする

DECLARE project_id   STRING DEFAULT 'my-project';
DECLARE udf_dataset  STRING DEFAULT 'ops_meta';   -- UDF の置き場所
DECLARE work_dataset STRING DEFAULT 'ops_meta';   -- テーブル / ビューの置き場所
DECLARE region       STRING DEFAULT 'asia-northeast1';
DECLARE tz           STRING DEFAULT 'Asia/Tokyo';
DECLARE partition_expiration_days INT64 DEFAULT 400;

DECLARE include_dataset_patterns ARRAY<STRING> DEFAULT [r'_([A-Za-z]{4})$'];
DECLARE suffix_pattern           STRING        DEFAULT r'_([A-Za-z]{4})$';
DECLARE suffix_list              ARRAY<STRING> DEFAULT [];
DECLARE analyze_options          STRING        DEFAULT '{"literalGroups":[],"mode":"class"}';

-- 作るオブジェクトの名前。prefix / suffix は UDF と テーブル・ビューで別に持つ
DECLARE object_prefix STRING DEFAULT '';
DECLARE object_suffix STRING DEFAULT '';
DECLARE system_name   STRING DEFAULT 'viewlgc';  -- システムを表す文字列。名前の前に付く
DECLARE udf_prefix    STRING DEFAULT '';
DECLARE udf_suffix    STRING DEFAULT '';

-- base 名は作るオブジェクトごとに 1 つ
DECLARE diff_table_base  STRING DEFAULT 't_diff_hist';  -- t_=transaction / m_=master
DECLARE latest_view_base STRING DEFAULT 't_diff';
DECLARE info_fn_base     STRING DEFAULT 'VIEW_GROUP_INFO';
DECLARE css_fn_base      STRING DEFAULT 'VIEW_GROUP_CSS';
```

### 作るオブジェクトの名前

命名規則に沿って組み立てる。prefix / suffix は UDF と テーブル・ビューで別々に持つ。

| 種別 | 組み立て |
|---|---|
| テーブル | `object_prefix` + `system_name` + `_` + `<base 名>` + `object_suffix` |
| ビュー | `object_prefix` + `system_name` + `_` + `vw_` + `<base 名>` + `object_suffix` |
| UDF | `udf_prefix` + `UPPER(system_name)` + `_` + `<関数の基本名>` + `udf_suffix` |

`system_name` はこのシステムを表す文字列で、テーブル・ビューでは `t_` / `vw_t_` の
**前**、UDF では関数名の**前**に付く。**UDF 側だけ大文字**にするのは、関数名を
大文字で書く慣習に合わせるため（`viewlgc_VIEW_GROUP_INFO` にならないように）。
区切りの `_` は自動で足すので値には書かない。空にすればシステム名なしになる。

base 名は**作るオブジェクトごとに 1 つ**持たせてある。オブジェクトが増えたときは
`<名前>_base` の DECLARE を 1 行足し、組み立て先の `DECLARE <名前> STRING;` と
`SET <名前> = CONCAT(…);`、本文で使う `@@…@@` を対で増やす。

| 変数 | 作られるもの | 既定でできる名前 |
|---|---|---|
| `diff_table_base` | 日次スナップショットを積むテーブル | `viewlgc_t_diff_hist` |
| `latest_view_base` | 最新スナップショットだけのビュー | `viewlgc_vw_t_diff` |
| `info_fn_base` | 比較 HTML を返す UDF | `VIEWLGC_VIEW_GROUP_INFO` |
| `css_fn_base` | テンプレート用 CSS を返す UDF | `VIEWLGC_VIEW_GROUP_CSS` |

base 名の先頭の `t_` / `m_` は transaction / master の区分。既定は `t_`
（日次のスナップショットを積むテーブルのため）。システムが何かは `system_name`
が表すので、base 名にはその中での役割（`diff`）だけを書く。

> **`system_name` は `build_table.sql` と `view_group_html.sql` の両方にある。
> `udf_prefix` / `udf_suffix` / 関数の基本名と合わせて、必ず同じ値にすること。**
> 食い違うと、作った関数を `build_table.sql` が見つけられない。

**テーブルだけ `_hist` が付く。** 実体が日次スナップショットの積み上げ
（`PARTITION BY snapshot_date`・過去日を消さない・`partition_expiration_days` で
落ちる）なのに対し、ビューは最新 1 日ぶんだけを返すため。base 名を
オブジェクトごとに分けてあるので、こういう付け分けができる。

> ビューの名前から `_latest` が消えているが、中身は変わらず最新スナップショットだけを
> 返す。履歴側に `_hist` を付けて区別する形にしたため。

`build_table.sql` の設定は次のとおり。ここが唯一の置き場所で、書き換えたら
そのまま実行する。生成の手順はない。

| 変数 | 役割 |
|---|---|
| `include_dataset_patterns` | 対象データセット。空配列ならリージョン内すべて |
| `exclude_dataset_patterns` | 落とすデータセット。include のあとに効く |
| `include_view_patterns` | 対象 View 名（`table_name`）。空配列なら絞らない |
| `exclude_view_patterns` | 落とす View 名。include のあとに効く |
| `suffix_pattern` | データセット名から suffix を切り出す正規表現（1 つ目のキャプチャ） |
| `suffix_list` | suffix 一覧。空なら `suffix_pattern` で自動抽出。データセット名から導けないときだけ並べる |
| `analyze_options` | UDF に渡す解析オプション（JSON）。`literalGroups` をここで足せば再生成が要らない |
| `partition_expiration_days` | 履歴の保持日数 |

4 つとも同じ形で、**include は OR、そのあと exclude を `AND NOT` で足す**。
複数書けるので 1 本の正規表現に詰め込む必要はない。
照合は部分一致（`REGEXP_CONTAINS`）なので、完全一致にしたいなら `^…$` を付ける。

```sql
DECLARE include_dataset_patterns ARRAY<STRING> DEFAULT [r'^mart_', r'^dwh_'];
DECLARE exclude_dataset_patterns ARRAY<STRING> DEFAULT [r'_sandbox$'];
-- 特定のデータセットだけ試す
DECLARE include_dataset_patterns ARRAY<STRING> DEFAULT [r'^mart_abjp$', r'^mart_abus$'];
```

組み立てた条件文は `SCHEMATA` と `VIEWS` の両方に効く。見る列が
`schema_name` / `table_schema` / `table_name` と違うので、条件文は 3 本作る。

**View 名の絞り込みは `table_name`（suffix を含んだ実際の View 名）に効く。**
base 名ではないので、`^v_daily_sales$` は `v_daily_sales_abjp` に一致しない。
その base だけ見たいなら `^v_daily_sales_` のように書く。

```sql
-- 特定の base だけ試す
DECLARE include_view_patterns ARRAY<STRING> DEFAULT [r'^v_daily_sales_'];
-- 作業用の View を除く
DECLARE exclude_view_patterns ARRAY<STRING> DEFAULT [r'_tmp$', r'_bk$', r'^wk_'];
```

落とした View はセクション 5-5b に一覧で出る。意図せず落ちていないか確かめられる。

**`suffix_list` が要るのはどういうときか。** 通常 suffix はデータセット名から
取れるが、View が suffix を持たないデータセットに置いてある構成
（同梱のサンプルがこれ。View は `sample_mart` にあり、suffix は
`sample_src_apac` など別のデータセットにある）だと導けない。
そのときだけ手で並べる。

**逆に、対象データセットを一覧で指定する変数は要らない。**
`dataset_patterns` に `^名前$` を並べれば同じことができる。

**BigQuery は識別子をクエリ パラメータにできない。** `@param` が使えるのは値だけで、
プロジェクト・データセット・関数名は渡せない。そこでスクリプト変数に持ち、
`EXECUTE IMMEDIATE` に渡す前にテキスト置換する。`@@PROJECT@@` / `@@UDF@@` /
`@@WORK@@` / `@@REGION@@` / `@@TZ@@` / `@@DIFF_TABLE@@` / `@@LATEST_VIEW@@` /
`@@INFO_FN@@` / `@@CSS_FN@@` が置換される目印。

```sql
EXECUTE IMMEDIATE REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(r"""
INSERT INTO `@@PROJECT@@.@@WORK@@.@@DIFF_TABLE@@` …
""",
  '@@PROJECT@@',    project_id),
  '@@UDF@@',        udf_dataset),
  '@@WORK@@',       work_dataset),
  '@@REGION@@',     region),
  '@@TZ@@',         tz),
  '@@DIFF_TABLE@@', diff_table);
```

**この `REPLACE` の連鎖は一時 UDF にまとめてはいけない。** まとめると
セクション 3 の `CREATE OR REPLACE VIEW` が
`Creating views with temporary user defined functions is not supported` で落ちる。
永続 UDF にすると今度は**その関数名自身が `EXECUTE IMMEDIATE` の外に出る**ので、
プロジェクトとデータセットを置き換えられなくなる。呼び出しごとに展開するのが
いちばん単純で確実。

置換対象を最後に埋めるのは、埋めた中身がさらに置換されないようにするため
（`@@JS@@` が該当）。

**`SET @@location` は `DECLARE` より前に置く。** どちらのスクリプトも、参照は
すべて `EXECUTE IMMEDIATE` の中にあり、BigQuery がロケーションを推測できる
テーブル参照が無い。指定しないと既定のロケーションで実行され、目的の
データセットに作れない。`build_table.sql` では下の `region` と同じ値にする。

- **対象データセットはリージョン内から自動で拾う。** 既定は
  「suffix の条件に一致するデータセット全部」（下記）。
  リージョン単位の `INFORMATION_SCHEMA` を使うので `UNION ALL` は要らない
- **UDF 本体は `DECLARE js_info STRING DEFAULT r""" … """` に置く。**
  本体は `r""" """` で囲む必要があり、それをさらに `EXECUTE IMMEDIATE` の
  文字列に入れ子にできないため。埋めるときは `TO_JSON_STRING` で SQL の
  文字列リテラルに変換する（JSON のエスケープは BigQuery の文字列リテラルと互換）
- **スケジュールドクエリには セクション 0 と 2 を登録する。** 設定ブロックが
  無いと変数が未定義になる。1 と 3 は初回だけ、5 は確認用なので不要
- **セクション 5 の確認クエリは実行される。** ファイルを丸ごと流すと 8 本の
  結果が順に出る（生成結果 / 割れている base / 未認識の View / 対象データセットと
  suffix / データセット別の View 数 / View 名の条件で落ちた View /
  条件から外れたデータセット / 構成が変わった日）
- **セクション 1 は `CREATE OR REPLACE TABLE`。** 実行すると既存の行が消える
  （パーティションに積んだ履歴も含めて）。スキーマを変えたときに確実に作り直せる
  かわり、うっかり流すと履歴が飛ぶ。日次の生成には含まれない
- 生成器は書き出す前に、`@@…@@` が既知のものだけか、`r"""` の対応が取れているか、
  旧いプレースホルダが残っていないかを検査する

> `EXECUTE IMMEDIATE` に渡す本文は `r""" """` の生文字列。中に `"""` が出ると
> そこで切れるので、生成器が個数を数えて検査している。

> 最小化した JS には `'\u0001'` が**生の制御文字**として出る。そのまま埋めると
> 生成物に見えない文字が混ざるので、埋め込み時に `\uXXXX` へ戻している。

### 対象データセットはリージョン内から自動で拾う

suffix を出すデータセットと、比較対象の View があるデータセットは**同じ集合**なので、
別々に持つ意味がない。**リージョン単位の `INFORMATION_SCHEMA` が使える**ので、
データセットごとの `UNION ALL` を組み立てる必要もない。
1 つの `INSERT` の中で、同じ条件から両方を引く。

```sql
src AS (
  SELECT table_name AS view_name, view_definition AS ddl
  FROM `@@PROJECT@@.region-@@REGION@@.INFORMATION_SCHEMA.VIEWS`
  WHERE @@VIEW_COND@@   -- dataset_patterns から組み立てた OR の並び
),
```

**識別子と正規表現はテキスト置換、配列と JSON は `USING` のパラメータ**という
使い分けになる。正規表現をパラメータで渡さないのは、BigQuery の `REGEXP_*` が
パターンに定数を要求しうるため。

```sql
EXECUTE IMMEDIATE REPLACE(… r""" … """ …)
USING suffix_list AS suffix_list, analyze_options AS analyze_options;
```

絞り込みの手段は 3 つ。上から順に「普段」「テスト」「例外」。

絞り込みは上の 4 つの配列に集約してある。

**セクション 0 に事前チェックを置いてある。** 対象 View が 0 件、または suffix を持つ
データセットが 0 件なら `RAISE` で止まる。黙って空のテーブルを作ると
`region` や `dataset_patterns` の間違いに気づけないため。
`analyze_options` が JSON オブジェクトの形をしていない場合も止まる。

注意しておくこと:

- **条件に一致するが無関係な View を持つデータセットも対象に入る。**
  base ごとに束ねるので混ざりはしないが、1 View だけの base が並ぶ。
  include / exclude で絞れる
- `INFORMATION_SCHEMA.VIEWS` はリージョン単位で読むので、**そのリージョンの
  View 定義をすべて読む権限が要る**

## 事前生成テーブル（build_table.sql）

`build_table.sql` は手で編集するファイル。設定はセクション 0 の `DECLARE` だけ。

Looker の操作のたびに UDF を回すのは重いので、スケジュールドクエリで作り置きする。
`INFORMATION_SCHEMA` の中身は View をデプロイしたときしか変わらない。

```
viewlgc_t_diff_hist  PARTITION BY snapshot_date CLUSTER BY base
  base / view_count / group_count / has_multiple
  group_labels / group_sizes / suffixes / unmatched_count / diff_html
```

Looker Studio は `viewlgc_vw_t_diff` を読むだけ。`base` をプルダウンにして
`diff_html` を Templated Record に渡す。パラメータもカスタムクエリも UDF も不要。

パーティションに日付を積むので**履歴が残る**。「いつグループ構成が変わったか」を
後から追えるので、ロジック逸脱の検知に使える（`build_table.sql` の末尾に例あり）。

base の切り出しと UDF に渡す `suffixList` は、同じ 1 つの `suffixes` から作る。
別々に持つ場所がないので、ズレようがない。

## Looker Studio への配線

事前生成テーブルができていれば、あとは読むだけ。

1. **データを追加 → BigQuery** で `viewlgc_vw_t_diff`（`latest_view_base` から
   組み立てた名前）を選ぶ
   （カスタムクエリではなくテーブル選択でよい）
2. **Templated Record** を配置し、表示対象のカラムに `diff_html` を指定
3. **コントロール → プルダウン リスト**を置き、コントロール フィールドに `base`。
   **「単一選択にする」をオン**（1 レコード＝1 base を表示するため）
4. `mode='class'` で生成した場合は、テンプレートに CSS を貼る

CSS は **`template_style.html`**（`build_udf.mjs` の生成物）をそのまま貼るか、
BigQuery から取る。中身は同じ。

```sql
SELECT `<project>.<udf_dataset>.VIEWLGC_VIEW_GROUP_CSS`('{"mode": "class"}');
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
FROM `<project>.<work_dataset>.viewlgc_vw_t_diff`
ORDER BY base;
```

サンプルなら `v_daily_sales / 9 / 3 / [abjp, abuk, abus | …] / 0` になる。

> `group_count` が想定より多い場合は、BigQuery が返す DDL が投入したテキストと
> 違う（整形が正規化される、`OPTIONS` が付く等）可能性がある。
> `diff_html` を見れば何が差分として残ったか分かる。
