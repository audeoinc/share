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

#### リテラルの中は語単位でも照合する

リテラルには `'abjp'` そのものではなく、**suffix と連動した別表記**が入ることが多い。

```sql
WHERE country = 'JP'   -- v_x_abjp
WHERE country = 'US'   -- v_x_abus
```

これは文字列としての suffix と一致しないので、上の伏せ字だけでは吸収できず、
リテラル差＝ロジック差として別グループに割れてしまう。

そこで**文字列・バッククォート識別子の中だけ**、語（`[A-Za-z0-9]+` の並び）単位で
その View の**suffix 語彙**と照合する。語彙は suffix 自身とその区分
（`abjp` なら `ab` / `jp`）で、大文字小文字は無視する。

- 語**全体**が一致したときだけ置き換える。`'label'` の `ab` は巻き込まない
- 区分は `suffixParts` があればそれ、なければ長さが偶数のときの前後半
- 照合するのは**その View 自身の**語彙だけ。`abus` の View に `'JP'` が
  書いてあれば吸収されず差として残る（＝取り違えを見逃さない）
- `'A'` と `'B'` のような連動しない値は従来どおりロジック差

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
- 照合は suffix 語彙と同じ規則。**文字列・バッククォート識別子・数値の中**を
  語単位・大文字小文字を無視して見る。`'apacific'` の `apac` は巻き込まない
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

## suffix はデータセット名から自動で拾う（既定）

suffix の一覧を人が書いて維持するのは、**View が増えたときに黙って壊れる**種類の
運用になる。幸い、**suffix として使われている文字列はデータセット名の末尾にも
現れる**（`mart_abjp` / `raw_cduk`）。ここから拾えば手運用が要らなくなる。

`suffix_config.json` の既定はこれ。

```json
{
  "suffixSource": "schemata",
  "schemataPattern": "_([A-Za-z]{4})$",
  "region": "asia-northeast1"
}
```

生成される SQL は `INFORMATION_SCHEMA.SCHEMATA` を舐めて suffix 一覧を作り、
それを View 名との `ENDS_WITH` で突き合わせて base を切る。UDF に渡す
`suffixList` も同じ一覧から組み立てるので、**suffix が増えても SQL の修正は不要**。

```sql
suffixes AS (
  SELECT DISTINCT REGEXP_EXTRACT(schema_name, r'_([A-Za-z]{4})$') AS suffix
  FROM `PROJECT.region-asia-northeast1.INFORMATION_SCHEMA.SCHEMATA`
  WHERE REGEXP_CONTAINS(schema_name, r'_([A-Za-z]{4})$')
)
```

`REGEXP_EXTRACT` で base を切らないのは、**BigQuery の `REGEXP_*` がパターンに
定数を要求しうる**ため。実行時に決まる一覧から正規表現を組み立てるのは避けて、
`ENDS_WITH` の結合にしてある（複数一致したら長いほうを採る）。

注意点:

- リージョンは `suffix_config.json` の `region`（既定 `asia-northeast1`）から生成する。
  **データセットのロケーションと揃える**こと。ここを間違えると suffix が 0 件になり、
  **全 View が「suffix 未認識」として 1 本ずつ単独で並ぶ**
  （0 件にはならないので気づきにくい）。`unmatched_count > 0` の件数で確認する
- **サンプルは View を 1 つのデータセット（`sample_mart`）にまとめてある**ので、
  自動検出では拾えない。`source_datasets = ['sample_mart']` と
  `suffix_override = ['abjp', 'abuk', …]` を指定して試す
- `build_table.mjs` は書き出す前に、`ENDS_WITH` の切り出しと `analyze.js` の抽出が
  同じ base を返すかを照合する
- **無関係なデータセットも `_` + 4 文字英字で終われば拾われる**。害が出るのは
  その文字列で終わる View 名がある場合だけだが、気になるなら `schemataPattern` を
  絞る（例: `^mart_([A-Za-z]{4})$`）

手で決めたい場合は `"suffixSource": "config"` にすると、下の 3 通りの指定に戻る。

## suffix パターンを変更する手順

**設定は [`suffix_config.json`](./suffix_config.json) の 1 箇所だけ。**
suffix 規則は SQL 側（base の切り出し）と UDF 側（`options_json`）の
両方で必要になるが、手で 2 箇所書くとズレて base の束ね方と解析が食い違うので、
1 つの設定から両方を生成する。

```bash
# 1. suffix_config.json を直す
# 2. SQL を作り直す（SQL 側の切り出しと analyze.js の抽出が一致するか検証してから書き出す）
node build_table.mjs

# 3. 変更が UDF の既定値にも関わる場合は UDF も作り直す
node build_udf.mjs
```

`build_table.mjs` は書き出す前に、**SQL 側の切り出しと `analyze.js` の抽出が
同じ base を返すか**を照合する。食い違えば失敗して SQL は出力されない。

そのあと BigQuery で:

1. `view_group_html.sql`（UDF を作り直した場合のみ）
2. `build_table.sql`
3. 表示が変わる設定を触ったら `template_style.html` も貼り直す

> UDF は `options_json` を実行時に受け取るので、**suffix 規則を変えるだけなら
> UDF の作り直しは不要**。`build_table.sql` の再実行だけでよい。

### 手で指定する場合（suffixSource: "config"）

上から優先される。`suffixSource: "schemata"` のときは `suffixList` が実行時に
入るので、ここの指定は使われない（`suffixParts` はサンプル用の固定一覧として
コメントに残るだけ）。

| 指定 | 用途 |
|---|---|
| `suffixParts: [['ab','cd','ef'], ['jp','us','uk']]` | **区分の組み合わせ**。規則が最もはっきりする。内訳（`parts: ['ab','jp']`）も返る |
| `suffixList: ['abjp', 'abus', …]` | 既知の一覧を直接指定 |
| `suffixPattern: '^(.*?)_([A-Za-z0-9]{1,6})$'` | 正規表現。既定は末尾の `_` + 1〜6 文字 |

`v_daily_sales` のように suffix を持たない名前は `unmatched` に入る。

`suffixPattern` を使う場合は `^(base)(suffix)$` の形で**キャプチャを 2 つ**持たせる。
1 つ目が base、2 つ目が suffix になる。

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
node test.mjs               # アナライザの検証（65 アサーション）
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
| 1 | 差分なしの案内（suffix 未認識の View もここ。単独で 1 View） |
| 2 | 2 ペイン（比較が 1 通りしかないので、タブ 1 枚は無駄） |
| 3 以上 | 最大グループを基準に、比較相手を**タブ**で切り替える |

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
node preview.mjs          # dist/preview.html を生成して検証（28 アサーション）
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
VIEW_GROUP_INFO  素 46.7 KB → 最小化 28.3 KB（上限比 94%）
VIEW_GROUP_CSS   素 46.4 KB → 最小化 28.0 KB（上限比 93%）
```

3-way 系と `alphaMap` を外しているが、**残りは 32 KB に対して 3.7 KB ほど**。
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

-- build_table.sql
SET @@location = 'asia-northeast1';   -- DECLARE より前。region と同じ値にする

DECLARE project_id   STRING DEFAULT 'my-project';
DECLARE udf_dataset  STRING DEFAULT 'ops_meta';   -- UDF の置き場所
DECLARE work_dataset STRING DEFAULT 'ops_meta';   -- view_logic_diff の置き場所
DECLARE region       STRING DEFAULT 'asia-northeast1';
DECLARE tz           STRING DEFAULT 'Asia/Tokyo';

DECLARE dataset_filter  STRING        DEFAULT '';  -- 追加の絞り込み正規表現（テスト用）
DECLARE source_datasets ARRAY<STRING> DEFAULT [];  -- 空でなければこの一覧だけを使う
DECLARE suffix_override ARRAY<STRING> DEFAULT [];  -- 空でなければ suffix はこれを使う
```

**BigQuery は識別子をクエリ パラメータにできない。** `@param` が使えるのは値だけで、
プロジェクト・データセット・関数名は渡せない。そこでスクリプト変数に持ち、
`EXECUTE IMMEDIATE` に渡す前にテキスト置換する。`@@PROJECT@@` / `@@UDF@@` /
`@@WORK@@` / `@@REGION@@` / `@@TZ@@` / `@@SRC@@` が置換される目印。

```sql
EXECUTE IMMEDIATE REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(r"""
INSERT INTO `@@PROJECT@@.@@WORK@@.view_logic_diff` …
""",
  '@@PROJECT@@', project_id),
  '@@UDF@@',     udf_dataset),
  '@@WORK@@',    work_dataset),
  '@@REGION@@',  region),
  '@@TZ@@',      tz);
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
データセットに作れない。`build_table.sql` では下の `region` と同じ値にする
（どちらも `suffix_config.json` の `region` から生成される）。

- **対象データセットはリージョン内から自動で拾う。** 既定は
  「suffix の条件に一致するデータセット全部」（下記）。
  リージョン単位の `INFORMATION_SCHEMA` を使うので `UNION ALL` は要らない
- **UDF 本体は `DECLARE js_info STRING DEFAULT r""" … """` に置く。**
  本体は `r""" """` で囲む必要があり、それをさらに `EXECUTE IMMEDIATE` の
  文字列に入れ子にできないため。埋めるときは `TO_JSON_STRING` で SQL の
  文字列リテラルに変換する（JSON のエスケープは BigQuery の文字列リテラルと互換）
- **スケジュールドクエリには セクション 0 と 2 を登録する。** 設定ブロックが
  無いと変数が未定義になる。1 と 3 は初回だけ、5 は確認用なので不要
- **セクション 5 の確認クエリは実行される。** ファイルを丸ごと流すと 7 本の
  結果が順に出る（生成結果 / 割れている base / 未認識の View / 対象データセットと
  suffix / データセット別の View 数 / 条件から外れたデータセット / 構成が変わった日）
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
  WHERE IF(ARRAY_LENGTH(@source_datasets) > 0,
           table_schema IN UNNEST(@source_datasets),
           REGEXP_CONTAINS(table_schema, r'_([A-Za-z]{4})$')
             AND (@dataset_filter = '' OR REGEXP_CONTAINS(table_schema, @dataset_filter)))
),
```

**識別子はテキスト置換、値は `EXECUTE IMMEDIATE` の `USING`** という使い分けになる。
`dataset_filter` も `source_datasets` も値なので、名前付きパラメータで渡せる。

```sql
EXECUTE IMMEDIATE REPLACE(… r""" … """ …)
USING dataset_filter AS dataset_filter,
      source_datasets AS source_datasets,
      suffix_override AS suffix_override;
```

絞り込みの手段は 3 つ。上から順に「普段」「テスト」「例外」。

| 変数 | 既定 | 用途 |
|---|---|---|
| （なし） | — | リージョン内で条件に一致するデータセット全部 |
| `dataset_filter` | `''` | 追加の正規表現で絞る。`'^sample_'` のようにテスト時だけ狭める |
| `source_datasets` | `[]` | 自動検出をやめて一覧を直接指定する |
| `suffix_override` | `[]` | suffix だけ直接指定する（View が suffix 無しのデータセットにある場合） |

**セクション 0 に事前チェックを置いてある。** 対象 View が 0 件、または suffix を持つ
データセットが 0 件なら `RAISE` で止まる。黙って空のテーブルを作ると
`region` や `dataset_filter` の間違いに気づけないため。

注意しておくこと:

- **条件に一致するが無関係な View を持つデータセットも対象に入る。**
  base ごとに束ねるので混ざりはしないが、1 View だけの base が並ぶ。
  `dataset_filter` で絞れる
- `INFORMATION_SCHEMA.VIEWS` はリージョン単位で読むので、**そのリージョンの
  View 定義をすべて読む権限が要る**

## 事前生成テーブル（build_table.sql）

`build_table.sql` は `build_table.mjs` の生成物。直接編集しない。

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

base の切り出しと UDF の `options_json` は `suffix_config.json` から同時に
生成されるので、揃っていることが保証される。既定（`suffixSource: "schemata"`）では
どちらも `SCHEMATA` から取った同じ suffix 一覧を使う。

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
SELECT `<project>.<udf_dataset>.VIEW_GROUP_CSS`('{"mode": "class"}');
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
FROM `<project>.<work_dataset>.v_view_logic_diff_latest`
ORDER BY base;
```

サンプルなら `v_daily_sales / 9 / 3 / [abjp, abuk, abus | …] / 0` になる。

> `group_count` が想定より多い場合は、BigQuery が返す DDL が投入したテキストと
> 違う（整形が正規化される、`OPTIONS` が付く等）可能性がある。
> `diff_html` を見れば何が差分として残ったか分かる。
