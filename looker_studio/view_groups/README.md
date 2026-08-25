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

### 値の差を残したいときの仕組み（既定では出番がない）

> **ここから `equivalentLiterals` までの 3 節は、`"substitutable": ["entity"]` の
> ように値を置換対象から外した運用のためのもの。** 既定では値がパラメータ化されるので、
> 伏せ字も同値リテラルも効かせる必要がない。「値の差もロジック差として見たい」
> ときだけ読めばよい。

#### 比較の前に suffix を伏せ字にする（suffixAware・既定 on）

suffix はいろいろな場所に現れる。データセット名（`mart_abjp`）、テーブル名
（`orders_abjp`）、リテラル（`'abjp' AS region`）。実体名の差は α 等価が吸収するが、
値を置換対象から外すと、suffix 入りのリテラルがあるだけで
「本当は同じロジックなのに 9 本が 9 グループに割れる」ことになる。

そこで比較の直前に、**その View 自身の suffix をトークン内で伏せ字**にする。
suffix 由来の差は場所を問わず消え、**残った差＝本当のロジック差**になる。

```
v_x_abjp:  WHERE src = 'load_abjp'  →  WHERE src = 'load_␀'   ┐ 同じ
v_x_abus:  WHERE src = 'load_abus'  →  WHERE src = 'load_␀'   ┘
v_y_abjp:  WHERE status = 'A'                                 ┐ 違う
v_y_cdjp:  WHERE status = 'B'                                 ┘
```

値をまるごと置換対象にする（既定）のとは違う。あちらは `'A'` と `'B'` の差も
パラメータにするが、伏せ字は suffix に一致する部分だけを対象にするので、そこが残る。

伏せ字は比較用のトークン列にだけ効く。パラメータ化と表示は元のテキストを使うので、
`{{P1}}` の値には `orders_abjp` / `orders_abus` がそのまま並ぶ。

`suffixAware: false` で無効化できる。

##### リテラルは値がまるごと一致したときだけ照合する

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

##### 同値とみなす文字列は 1 本の一覧で持つ（equivalentLiterals）

`'aa'` ↔ `'bb'` や `'apac'` ↔ `'amer'` のように、**suffix とは別の語彙で連動して
いる**値は機械的には導けない。数が多くないのなら、並べて持つのが確実で
見通しもよい。**suffix 由来の語彙も含めて 1 本の配列**に並べる。

```json
"equivalentLiterals": [
  "suffix",
  ["aa", "bb"],
  ["cc", "dd"]
]
```

- **`"suffix"` は予約語**で、「その View 自身の suffix とその区分」を表す
  （`v_x_abjp` なら `abjp` / `ab` / `jp`）。**View ごとに中身が変わるので値を
  並べて書けない**。これがこの一覧で唯一、View に依存する要素
- **明示の組は View に依存しない。** `['aa','bb']` はどの View でも効く
- **1 つの配列が 1 つの同値類**。別の配列どうしは同一視しないので、
  `'aa'` と `'cc'` が意図せず同じになることはない
- 照合は**文字列リテラルと数値リテラルの値そのもの**を大文字小文字を無視して
  見る。`'x_aa_y'` の `aa` は巻き込まない
- 数値も並べられる（`["1","2","3"]`）
- 組を 1 つだけ書くつもりで `["aa","bb"]` と書いても、配列が 1 つも無ければ
  全体を 1 組として受ける（黙って無視しない）
- `suffixAware`（識別子の中の suffix 置換）とは独立に効く

> **`"suffix"` と明示の組では、取り違えの検知力が違う。** `"suffix"` は
> その View 自身の suffix としか照合しないので、`v_x_abus` に `'JP'` と
> 書いてあれば差として残る（＝取り違えに気づける）。明示の組は View に
> 依存しないので、`v_x_abjp` に `'bb'`、`v_x_abus` に `'aa'` という**入れ違いも
> 吸収してしまう**。位置まで対応づけたい場合は言ってもらえれば足せる。

旧い書き方（`literalSuffixWords` と `literalGroups` を別々に持つ）もそのまま
動く。`equivalentLiterals` を書いたときだけ、そちらが一覧の唯一の定義になる。

並べていない値はロジック差として残る。すべての値の差を吸収したいなら
`substitutable` を既定（`["entity","number","string"]`）に戻す。

何を伏せ字にしたかは「なぜ別グループになったか」に
`⟨suffix⟩` / `⟨同値リテラル 1 組目⟩` として出るので、効きすぎていないか確かめられる。

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

### 置換してよいのは「実体名」と「値」だけ

横展開は**ロジックが同じならコピーで行う**運用が前提。だから、SQL の中で閉じた
名前（列名・別名・CTE 名・ウィンドウ名・関数名）が違えば、それは環境差ではなく
**書き換えの差**になる。逆に、`FROM` / `JOIN` が指す実体名と値は環境ごとに変わって
当然なので、パラメータに置き換えて同じグループにする。

| 種別 | 例 | 扱い |
|---|---|---|
| `entity`（`FROM` / `JOIN` の参照先） | `` `p.d.orders_abjp` `` | **置換可** |
| `string` / `number`（値） | `'JP'` / `1` | **置換可** |
| 列名・別名・CTE 名・ウィンドウ名・関数名 | `amount` / `o` / `daily` | 完全一致 |
| 予約語・記号 | `SUM` / `LEFT` / `,` | 完全一致 |

```
SELECT o.amount AS total FROM `p.d.orders_abjp` AS o JOIN d.items_abjp AS i ON o.k = i.k
       └───┬──┘    └─┬─┘      └────────┬───────┘    └┬┘      └────┬────┘    └┬┘
        完全一致    完全一致        置換可          完全一致    置換可      完全一致
```

**表記は正規化しない。** バッククォートの有無やパスの部分数が違えばトークン数が
変わり、そのまま別グループになる。「意味が同じでも書き方が違えば別グループ」という
方針どおりで、コピー運用なら書き方も揃うため実害はない。

| 差 | 結果 |
|---|---|
| `` FROM `p.d.t_abjp` `` vs `` `p.d.t_abus` `` | 同一（パラメータ化） |
| `FROM p.d.t_abjp` vs `p.d.t_abus` | 同一（パラメータ化） |
| `` FROM `p.d.t_abjp` `` vs `` `d.t_abus` `` | 同一（クォート内の構造は問わない） |
| `` FROM `p.d.t_abjp` `` vs `FROM p.d.t_abus` | **別グループ**（トークン数が違う） |
| `FROM p.d.t_abjp` vs `FROM d.t_abus` | **別グループ**（トークン数が違う） |

実体名の判定は**位置だけ**で行う（パーサーは要らない）。`FROM` / `JOIN` の直後に
来る名前が実体名で、`FROM (SELECT …)` / `FROM UNNEST(x)` / `EXTRACT(HOUR FROM ts)`
の `FROM` は対象外。

**値の差もロジック差として残したい**なら `"substitutable": ["entity"]` を指定する。
そのとき効くのが下記の伏せ字と `equivalentLiterals`。既定では値が置換対象なので
出番がない。

**何をパラメータとみなしたかは必ず `params` で返す。** 判定が正しいかを人が確認
できるようにするため。パラメータ一覧には種別（実体名 / 値）も出るので、
「実体名の差は流し見、値の差は業務上の意味があるので確認する」と読み分けられる。

## 設定は build_table.sql の DECLARE だけ

**設定ファイルは持たない。** 開発中に設定の置き場所が複数あると、期待どおりの
値でテストできているのかを毎回確かめる羽目になり、不具合の切り分けが遅くなる。
`build_table.sql` は生成物ではなく、**直接編集するファイル**。

`analyze.js` / `render_groups.js` から作るのは `view_group_html.sql`（UDF 本体）
だけで、そちらの設定も先頭の `DECLARE` にある。

| ファイル | 位置づけ |
|---|---|
| `build_table.sql` | 手で編集する。設定は CONFIGURATION の `DECLARE` |
| `view_group_html.sql` | `build_udf.mjs` の生成物。JS を最小化して埋めるため。設定は先頭の `DECLARE` |
| `template_style.html` | `build_udf.mjs` の生成物（CSS） |

**両ファイルで必ず同じ値にする `DECLARE`** は `system_name` / `udf_dataset` /
`udf_name_prefix` / `udf_name_suffix` / `project_token_pattern` の 5 つ。
食い違うと `build_table.sql` が関数を見つけられない。`node check_sql.mjs` が
名前の組み立てと `system_name` の既定値を突き合わせる。

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
         SELECT DISTINCT REGEXP_EXTRACT(schema_name, r'__SUFFIX_PATTERN__')
         FROM `__TARGET_PROJECT__.region-__JOB_REGION__.INFORMATION_SCHEMA.SCHEMATA`
         WHERE REGEXP_CONTAINS(schema_name, r'__SUFFIX_PATTERN__')
           AND (__SCHEMA_COND__)
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

- ロケーションは `SET @@location` が唯一の置き場所（`job_region` はそこから
  受け取る）。データセットのロケーションと違うと事前チェックの `ASSERT` で止まる
- **サンプルは View を 1 つのデータセット（`sample_mart`）にまとめてある**ので、
  自動検出では拾えない。`analysis_include_dataset_patterns = [r'^sample_mart$']` と
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
> `equivalentLiterals` を変えるだけなら UDF の作り直しは不要**。
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
node test.mjs               # アナライザの検証（184 アサーション）
```

| ファイル | 内容 |
|---|---|
| `sample_data.sql` | データセット 4 つ・ソース テーブル 18 本・View 9 本を作る |
| `sample_teardown.sql` | 片付け（データセットごと DROP） |
| `sample_views.js` | サンプルの定義。**SQL 生成とテストが同じものを参照する** |
| `sample_complex.js` | 判定を痛めつけるための複雑な View 1 本（BigQuery には作らない） |

### 複雑な SQL での検証

単純な `SELECT` だけだと、実体名の検出（`FROM` / `JOIN` の位置判定）が素通りして
しまう。`sample_complex.js` に**多段 CTE / CTE の相互参照 / UNNEST を伴うカンマ結合 /
名前付きウィンドウ / QUALIFY / LEFT JOIN … USING / スカラー サブクエリ /
EXISTS 相関サブクエリ / CASE / STRUCT / UNION ALL / バッククォートあり・なしの参照**
を 1 本に詰めた View を置いて、次の両方を見ている。

- **取りこぼしていないか** — 実体名を拾い損ねると、環境差なのに別グループに割れる
- **拾いすぎていないか** — 実体名でないものを拾うと、本物の差を見逃す

**横展開でいちばん多いのは `WHERE` / `IF` / `CASE` の条件をリテラルで指定して
いる箇所**（国ごとにしきい値・区分値・対象コードが変わる）なので、そこは
専用の検証ブロックで細かく見ている。

| 差 | 結果 |
|---|---|
| `s = 'A'` vs `'B'` / `n = 1` vs `2` | 同一（値としてパラメータ化） |
| `DATE '2025-01-01'` vs `'2025-04-01'` | 同一 |
| `LIKE 'AB%'` vs `'CD%'` | 同一 |
| `BETWEEN 1 AND 10` vs `5 AND 20` | 同一 |
| `IN ('A','B')` vs `('C','D')` | 同一 |
| `CASE WHEN n >= 100 THEN 'BIG'` vs `>= 200 THEN 'LARGE'` | 同一 |
| `IF(n >= 100, 'A', 'B')` vs `IF(n >= 200, 'C', 'D')` | 同一 |
| **`IN` の要素数が違う** | 別グループ |
| **`WHEN` の数 / `ELSE` の有無が違う** | 別グループ |
| **`>=` vs `>`** | 別グループ |
| **条件の順序が違う** | 別グループ |
| **`IF` と `CASE` の書き換え** | 別グループ |
| **`f = TRUE` vs `FALSE`** | 別グループ（真偽値は予約語） |
| **`IS NULL` vs `IS NOT NULL`** | 別グループ |
| **`a='X' AND b='X'` vs `a='Y' AND b='Z'`** | 別グループ（対応が 1 対 1 にならない） |

値だからと何でも同一視するわけではなく、**一貫した 1 対 1 の置き換えになる
ときだけ**まとめる。同じ値が別々の値に対応していれば `inconsistent`、
別々の値が同じ値に対応していれば `not-injective` で割れる。

### リテラルの書き方は lineage の lexer に合わせてある

**1 つのリテラルを複数トークンに割ってしまうと、値の差なのに
「トークン数が違う」で別グループになる。** lineage の
`javascript/src/lexer/lexer.js` が扱っている形と突き合わせて、
こちらのトークナイザに次を足した。

| 書き方 | 直す前 |
|---|---|
| 単一引用符 3 連 / 二重引用符 3 連（複数行） | 空文字 ＋ 中身 ＋ 空文字 の 3 トークンに割れていた |
| `r'…'`（raw）/ `b'…'`（bytes）/ `rb` / `br` | 接頭辞が識別子として切り離されていた |
| 引用符の二重化 `'it''s'` | 2 つの文字列に割れていた |
| 指数表記 `1e6` / `2E-4` | 数値 ＋ 識別子に割れていた（**値の差で別グループになる**） |
| 16 進 `0x1F` | 同上 |
| 先頭ドットの小数 `.5` | 記号 ＋ 数値に割れていた |

**指数表記と 16 進は実害があった。** `n > 1e6` と `n > 2e7` が
`1` ＋ `e6` / `2` ＋ `e7` に割れ、`e6` と `e7` は識別子なので置換対象外 →
値の差なのに別グループになっていた。

raw 文字列は本体のエスケープを解釈しない形で読む。`r'…\'` のように
バックスラッシュで終わる正規表現があると、エスケープとして読んだ瞬間に
閉じ引用符を見失い、そこから先の SQL を丸ごと飲み込んでしまうため。

小数点のあとに数字を必須にしているのは、`p.d.t_123` の `.` を数値に
食わせないため（lineage も同じ理由で場合分けしている）。食わせるとパスが
壊れ、実体名の検出まで狂う。

> lineage は名前付きクエリ パラメータ `@name` と位置パラメータ `?` も
> 1 トークンとして読むが、View の定義には現れないので入れていない。

知っておいたほうがよい端の挙動:

- **真偽値と `NULL` は予約語**なので、`TRUE` / `FALSE` の差は値ではなく構造の差
  として割れる。意味としてもロジック差なので、この扱いでよいと考えている
- **負号はトークンが 1 つ増える。** `IFNULL(n, 0)` と `IFNULL(n, -1)` は割れるが、
  `-1` と `-2` は同一になる
- **`1` と `1.0` は同一になる。** どちらも数値トークンなので、表記のゆれでは
  割れない（バッククォートの有無とは扱いが違う）

これで実際に 2 件の取りこぼしが見つかった。

| 症状 | 原因 |
|---|---|
| `FROM a AS x, b AS y` の **2 つ目以降を拾えない** | 別名を読み飛ばしていなかった。suffix の伏せ字が効いていると症状が隠れる |
| `ML.PREDICT(…)` を**実体名として拾う** | ドット区切りのパスを先に印付けしてから `(` を見ていた。関数が差し替わっても同じロジックに見えてしまう |

`node preview.mjs` の最後のケースで、複雑な SQL の差分表示を目で確認できる。

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

**グループ数によらずタブ。タブの枚数がそのままグループ数になる。**

| グループ数 | レイアウト |
|---|---|
| 1 | 基準タブ 1 枚 ＋ **SQL 1 ペイン**（suffix 未認識の View もここ。単独で 1 View） |
| 2 以上 | 基準タブ ＋ 比較相手のタブ。中身は 2 ペイン比較 |

**先頭は基準グループのタブで、常に選択状態のまま固定**する（`<label>` ではなく
`<span>` なので押しても切り替わらない）。基準は左ペインに出っぱなしなので、
タブが比較相手の分しか無いと**タブの数とグループ数が食い違って見える**。
基準の分も並べておけば、タブを数えればグループ数になる。

```
[ 基準 abjp, abuk, abus 3 ][ cdjp, cduk, cdus 3 ][ efjp, efuk, efus 3 ]
   ↑ 常に選択（左ペイン）      ↑ ここだけ切り替わる（右ペイン）
```

基準タブの色は**基準ペインと同じ薄い赤**（`render.js` の `paneColors.base`）。
`chromeCss()` は静的なので既定値を焼き込んである。`opts.colors.baseColor` を
変えたときは、こちらも直す必要がある。

**全 View が同一ロジックなら比較しない。** 同じ SQL を左右に並べても読む人が得る
ものが無いので、`renderFragment1` で 1 ペインだけ出す。差分の色分け（`+` / `−`
マーカー・行背景・ハッチ）は出番が無いので付かず、行番号と SQL だけになる。

見た目は **2 ペインの左ペインとそろえてある**。`style` 属性の中身まで同じにするのは、
`mode='class'` が `style` をハッシュしてクラス名にするため。新しい組み合わせを作ると
**テンプレートに貼った CSS を貼り直すまでその部分が素のまま**になり、`<th>` が
ブラウザ既定の中央寄せで出るなど、他と違う見た目になる。`build_udf.mjs` の
クラス網羅チェックは 1 ペイン・suffix 未認識も含めて見るようにしてある。

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

SQL 中の `{{P1}}` にカーソルを合わせると、種別と suffix ごとの実際の値が
吹き出しで読める。末尾の一覧まで目を往復させずに済ませるため。
目印を付けるのは `render.js` の `withTips()`、見た目は `chromeCss()` の `.vg-ph`。

- JavaScript は使えないので `:hover::after` ＋ `content:attr(data-tip)`。
- **値は `data-tip` 属性に置く。** 子要素として置くと、CSS を貼り忘れたときに
  値が SQL 本文に流れ出す。属性なら何も出ないだけで済む。
- 絶対配置の既定の幅は「収まる幅」＝目印の幅しかない。`width:max-content` を
  付けないと 1 文字ずつ折り返した細長い吹き出しになる。
- 右ペインは `.vg-phr` で右寄せにする。左寄せのままだと表の右端からはみ出す。
- 吹き出しは最終行では表の下へ出るので、`wrapTable` の `overflow` を
  `visible` にしている（`tips` を渡したときだけ。Confluence 貼り付けは従来どおり
  `hidden`）。角の丸めが少し甘くなるが、読めないよりはよい。
- 行内差分は語単位（`{` `{` `P1` `}` `}`）で切るため、値が違う位置では
  目印がハイライトの `<span>` に割られる。目印の検出は途中にタグが入る形で
  書いてある（`PARAM_HTML_RE`）。
- パラメータ名はグループごとに振り直すので、左右のペインには別の対応表を渡す。

```bash
node preview.mjs          # dist/preview.html を生成して検証（54 アサーション）
node preview.mjs --check  # 生成せず検証だけ
```

## BigQuery UDF（view_group_html.sql）

```bash
node build_udf.mjs          # 検証して view_group_html.sql を生成
node build_udf.mjs --check  # 生成せず検証だけ（40 アサーション）
node check_sql.mjs          # build_table.sql と view_group_html.sql の突き合わせ
```

| 関数 | 戻り値 |
|---|---|
| `viewlgc_analyze(views, options_json)` | 解析結果の JSON（`viewCount` / `groupCount` / `groupLabels` / `groupSizes` / `suffixes` / `unmatchedCount` / `bases`） |
| `viewlgc_render(analysis_json, options_json)` | 比較 HTML |
| `viewlgc_group_css(options_json)` | `mode='class'` でテンプレートに貼る CSS |
| `viewlgc_render_dynamic_sql(sql_template, …)` | `build_table.sql` の `__…__` を展開した SQL（JavaScript ではなく SQL 関数） |

### 解析と描画は別の UDF に分ける

**インラインのコード ブロブは 1 個あたり 32 KB までに制限される（標準 SQL でも
同じ）。** 1 本にまとめると枠が 1 つしか使えず、実際 29.3 KB まで詰まっていた。
依存は素直に割れる（解析は `analyze.js` だけ、描画は `diff` / `render` /
`render_groups` だけ）ので、2 つの UDF に分けて枠を 2 つ使う。

```
viewlgc_analyze     素 23.3 KB → 最小化 10.6 KB（上限比 35%）
viewlgc_render      素 31.9 KB → 最小化 21.6 KB（上限比 72%）
viewlgc_group_css   素 33.2 KB → 最小化 22.3 KB（上限比 74%）
```

**JS UDF の中から別の UDF は呼べない。** JS は V8 のサンドボックスで動き、
SQL に戻る手段が無い。つなぐのは呼び出し側の SQL の仕事で、`build_table.sql` が
`analyze` を 1 回呼び、その結果を `render` に渡す。

```sql
analyzed AS (
  SELECT base, `__UDF_ANALYZE__`(ARRAY_AGG(…), (SELECT options_json FROM opts)) AS analysis
  FROM keyed GROUP BY base
)
SELECT
  CAST(JSON_VALUE(analysis, '$.viewCount') AS INT64) AS view_count,
  …
  `__UDF_RENDER__`(analysis, (SELECT options_json FROM opts)) AS diff_html
FROM analyzed
```

**スカラー SQL UDF で包まない**のは、式が 1 本しか書けず中間結果を変数に置けない
ため。メタデータ用と HTML 用で `analyze()` を 2 回書くことになり、解析が 2 回
走りかねない。呼び出し側の `WITH` なら 1 回で済む。

**UDF 間を渡る JSON は描画に要る分だけに削ってある。** 解析結果をそのまま積むと
サンプル 9 本で 62 KB になるが、`members[].tokens` / `raw` / `ddl` を落とせば
3 KB で足りる（描画結果は同じであることを検証で確かめている）。

`viewlgc_group_css` も描画側だけで作れるよう、CSS の fixture は `analyze()` を
通さず手で組んである。手組みが実物とズレていないかは、生成時のクラス網羅
チェック（実物のパイプラインで描いた markup と突き合わせる）が見張る。

3-way 系と `alphaMap` も外してある。これ以上詰まってきたら
`OPTIONS(library=["gs://…"])` への移行を検討する。

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
SET @@location = 'asia-northeast1';   -- DECLARE より前。ここが唯一の置き場所

BEGIN
-- [A] 環境ごとに必ず見るもの
DECLARE project_token_pattern STRING DEFAULT r'^([^-]+)';
DECLARE system_name     STRING DEFAULT 'viewlgc';      -- build_table.sql と同じ値に
DECLARE udf_dataset     STRING DEFAULT 'ops_meta';
DECLARE udf_name_prefix STRING DEFAULT '';
DECLARE udf_name_suffix STRING DEFAULT '';

-- build_table.sql
SET @@location = 'asia-northeast1';   -- DECLARE より前。ここが唯一の置き場所

BEGIN
-- [A] 環境ごとに必ず見るもの
DECLARE project_token_pattern STRING DEFAULT r'^([^-]+)';
DECLARE system_name       STRING DEFAULT 'viewlgc';    -- 全オブジェクト名の先頭
DECLARE work_dataset      STRING DEFAULT 'ops_meta';   -- テーブル / ビューの置き場所
DECLARE udf_dataset       STRING DEFAULT 'ops_meta';   -- UDF の置き場所
DECLARE table_name_prefix STRING DEFAULT '';
DECLARE table_name_suffix STRING DEFAULT '';
DECLARE udf_name_prefix   STRING DEFAULT '';
DECLARE udf_name_suffix   STRING DEFAULT '';
DECLARE analysis_include_dataset_patterns ARRAY<STRING> DEFAULT [r'_([A-Za-z]{4})$'];
DECLARE analysis_exclude_dataset_patterns ARRAY<STRING> DEFAULT [];
DECLARE analysis_include_object_patterns  ARRAY<STRING> DEFAULT [];
DECLARE analysis_exclude_object_patterns  ARRAY<STRING> DEFAULT [];
DECLARE snapshot_time_zone STRING DEFAULT 'Asia/Tokyo';   -- snapshot_date の基準

-- [B] 既定のままで動くもの
DECLARE partition_expiration_days INT64 DEFAULT 400;
DECLARE suffix_pattern  STRING        DEFAULT r'_([A-Za-z]{4})$';
DECLARE suffix_list     ARRAY<STRING> DEFAULT [];
DECLARE analyze_options STRING        DEFAULT '{"mode":"class"}';

-- [C] 導出・内部用。編集しない
DECLARE job_region STRING DEFAULT @@location;
DECLARE work_project_id   STRING DEFAULT NULL;  -- 自動検出した値を使う
DECLARE udf_project_id    STRING DEFAULT NULL;
DECLARE target_project_id STRING DEFAULT NULL;
```

設定は **[A] / [B] / [C] の 3 段**に分けてある。触るのは [A] だけで、[B] は
既定のままで動き、[C] は自動検出や組み立ての結果が入る。**プロジェクト ID は
`INFORMATION_SCHEMA.SCHEMATA.catalog_name` から実行時に自動検出する**ので、
書き換える必要はない（役割ごとに別プロジェクトへ置くときだけ [C] を固定する）。

データセット名と prefix / suffix には `{project_token}` と書ける。プロジェクト ID
から `project_token_pattern` で切り出したトークンに置き換わるので、環境ごとに
`table_name_prefix = '{project_token}_'` のような書き方ができる。置き換えられずに
残った `{project_token}` は `ASSERT` で落ちる。


### 作るオブジェクトの名前

命名規則に沿って組み立てる。prefix / suffix は UDF と テーブル・ビューで別々に持つ。

**lineage プロジェクトの命名にそろえてある**（`lineage/sql/setup/01_setup_lineage_environment.sql`）。

| 種別 | 組み立て |
|---|---|
| テーブル | `table_name_prefix` + `system_name` + `_` + 区分 + 基本名 + `table_name_suffix` |
| ビュー | `table_name_prefix` + `system_name` + `_` + `vw_` + 区分 + 基本名 + `table_name_suffix` |
| UDF | `udf_name_prefix` + `system_name` + `_` + 基本名 + `udf_name_suffix` |

**変数は `system_name` と prefix / suffix。** 区分（`t_` = transaction /
`m_` = master）と基本名は `SET` の行に**リテラルで書く**。区分は分類を変える
ときにしか動かないため。区切りの `_` は prefix / suffix の値に含めて書く。

`system_name`（既定 `viewlgc`）は **[A] の `DECLARE`** にあり、同じプロジェクトに
別のシステムが同居したときに名前だけで見分けるためのもの。**`build_table.sql` と
`view_group_html.sql` で必ず同じ値にすること。** 食い違うと関数が見つからない。
既定値が揃っているかは `node check_sql.mjs` が突き合わせる。ルーチン名には
`-` が使えないので、英数字と `_` だけ（`ASSERT` で落ちる）。

| SET する変数 | 作られるもの | 既定でできる名前 |
|---|---|---|
| `table_diff_hist` | 日次スナップショットを積むテーブル | `viewlgc_t_diff_hist` |
| `view_diff` | 最新スナップショット。基準 = 先頭グループの 1 行だけ | `viewlgc_vw_t_diff` |
| `view_diff_by_ref` | 同上。基準ごとに 1 行 | `viewlgc_vw_t_diff_by_ref` |
| `udf_analyze_function_name` | View 群を解析して JSON を返す UDF | `viewlgc_analyze` |
| `udf_render_function_name` | その JSON を比較 HTML にする UDF | `viewlgc_render` |
| `udf_css_function_name` | テンプレート用 CSS を返す UDF | `viewlgc_group_css` |
| `udf_sql_function_name` | 動的 SQL を展開する UDF | `viewlgc_render_dynamic_sql` |

オブジェクトが増えたときは `DECLARE <名前> STRING;` と `SET <名前> = …;` を
1 組足し、本文の `__…__` と `viewlgc_render_dynamic_sql` の置換も対で増やす。
足し忘れは `node check_sql.mjs` が見つける。

**テーブル側とは prefix / suffix を分けてある。** ルーチン名は英数字と `_` しか
使えず `-` が入らないのに対し、テーブル・ビューの参照はすべてバッククォート
引用なので `-tky` のようなハイフンが使える。混ぜると UDF 側だけ落ちる。

> **`udf_dataset` / `udf_name_prefix` / `udf_name_suffix` は
> `build_table.sql` と `view_group_html.sql` の両方にある。必ず同じ値にすること。**
> 食い違うと、作った関数を `build_table.sql` が見つけられない。
> `node check_sql.mjs` が組み立ての式が同じかどうかまで見る。

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
| `analysis_include_dataset_patterns` | 対象データセット。空配列ならリージョン内すべて |
| `analysis_exclude_dataset_patterns` | 落とすデータセット。include のあとに効く |
| `analysis_include_object_patterns` | 対象 View 名（`table_name`）。空配列なら絞らない |
| `analysis_exclude_object_patterns` | 落とす View 名。include のあとに効く |
| `suffix_pattern` | データセット名から suffix を切り出す正規表現（1 つ目のキャプチャ） |
| `suffix_list` | suffix 一覧。空なら `suffix_pattern` で自動抽出。データセット名から導けないときだけ並べる |
| `snapshot_time_zone` | `snapshot_date` の基準タイムゾーン。リージョンごとに変える（[A]） |
| `analyze_options` | UDF に渡す解析オプション（JSON）。`substitutable` などをここで足せば再生成が要らない |
| `partition_expiration_days` | 履歴の保持日数 |

4 つとも同じ形で、**include は OR、そのあと exclude を `AND NOT` で足す**。
複数書けるので 1 本の正規表現に詰め込む必要はない。
照合は部分一致（`REGEXP_CONTAINS`）なので、完全一致にしたいなら `^…$` を付ける。

```sql
DECLARE analysis_include_dataset_patterns ARRAY<STRING> DEFAULT [r'^mart_', r'^dwh_'];
DECLARE analysis_exclude_dataset_patterns ARRAY<STRING> DEFAULT [r'_sandbox$'];
-- 特定のデータセットだけ試す
DECLARE analysis_include_dataset_patterns ARRAY<STRING> DEFAULT [r'^mart_abjp$', r'^mart_abus$'];
```

組み立てた条件文は `SCHEMATA` と `VIEWS` の両方に効く。見る列が
`schema_name` / `table_schema` / `table_name` と違うので、条件文は 3 本作る。

**View 名の絞り込みは `table_name`（suffix を含んだ実際の View 名）に効く。**
base 名ではないので、`^v_daily_sales$` は `v_daily_sales_abjp` に一致しない。
その base だけ見たいなら `^v_daily_sales_` のように書く。

```sql
-- 特定の base だけ試す
DECLARE analysis_include_object_patterns ARRAY<STRING> DEFAULT [r'^v_daily_sales_'];
-- 作業用の View を除く
DECLARE analysis_exclude_object_patterns ARRAY<STRING> DEFAULT [r'_tmp$', r'_bk$', r'^wk_'];
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
プロジェクト・データセット・テーブル・関数名は渡せない。そこでテンプレートに
`__…__` の目印を書き、**永続 SQL UDF `viewlgc_render_dynamic_sql`** で展開してから
`EXECUTE IMMEDIATE` する。lineage の `lnge_render_dynamic_sql` と同じ形。

動的 SQL は **4 手**で書く。

```sql
SET sql_template = """
INSERT INTO `__T_DIFF_HIST__` …
""";
EXECUTE IMMEDIATE render_call_sql INTO rendered_sql USING sql_template AS sql_template;
ASSERT NOT REGEXP_CONTAINS(rendered_sql, r'__[A-Z0-9_]+__') AS '… に未展開のプレースホルダがあります。';
EXECUTE IMMEDIATE rendered_sql;
```

3 手目の `ASSERT` が効きどころ。**目印を足したのに関数側に置換を足し忘れると、
展開されないまま実行して意味不明な構文エラーになる**ところを、その場で
「未展開のプレースホルダがある」と言って止められる。

`render_call_sql` は**1 度だけ**組み立てて全テンプレートで使い回す。関数の場所は
変数で決まるので静的には書けず、呼び出し自体も動的 SQL になる。呼び出しごとに
変わるのは `@sql_template` だけなので、ほかの設定は焼き込む。

```sql
SET render_call_sql = FORMAT(
  """SELECT `%s.%s.%s`(@sql_template, %T, %T, …)""",
  udf_project_id, udf_dataset, udf_render_function_name,
  work_project_id, work_dataset, …);
```

**値は `%s` ではなく `%T` で埋める。** 条件文（`REGEXP_CONTAINS(schema_name, r'…')`）
には引用符が入るので、`%s` だと呼び出し側の文字列リテラルが壊れる。`%T` は
値から**妥当な SQL リテラル**を作るのでエスケープを自分で書かずに済む。

**永続関数なのは、一時 UDF が使えないから。** スクリプトに `CREATE TEMP FUNCTION`
を 1 つでも置くと、セクション 3 の `CREATE OR REPLACE VIEW` が
`Creating views with temporary user defined functions is not supported` で落ちる。
加えて BigQuery は一時 UDF の DDL を**子ジョブすべてのクエリ本文に前置する**ので、
コンソールの結果一覧がどれも同じ DDL に見えてしまう。永続関数ならどちらも起きない。

置換の順番は、**中身が SQL になるもの（`__*_COND__`）を最後**にする。
先に埋めると、埋めた中身がさらに走査される。

**`SET @@location` は `DECLARE` より前に置く。** どちらのスクリプトも、参照は
すべて `EXECUTE IMMEDIATE` の中にあり、BigQuery がロケーションを推測できる
テーブル参照が無い。指定しないと既定のロケーションで実行され、目的の
データセットに作れない。`job_region` はこの値を `DEFAULT @@location` で受け取るので、
**ロケーションの置き場所は先頭の 1 行だけ**になる。

- **対象データセットはリージョン内から自動で拾う。** 既定は
  「suffix の条件に一致するデータセット全部」（下記）。
  リージョン単位の `INFORMATION_SCHEMA` を使うので `UNION ALL` は要らない
- **UDF 本体は `DECLARE js_info STRING DEFAULT r""" … """` に置く。**
  本体は `r""" """` で囲む必要があり、それをさらに `EXECUTE IMMEDIATE` の
  文字列に入れ子にできないため。埋めるときは `TO_JSON_STRING` で SQL の
  文字列リテラルに変換する（JSON のエスケープは BigQuery の文字列リテラルと互換）
- **スケジュールドクエリには CONFIGURATION と セクション 2 を登録する。** 設定
  ブロックが無いと変数が未定義になる。1 と 3 は初回だけ、5 は確認用なので不要
- **セクション 5 の確認クエリは実行される。** ファイルを丸ごと流すと 8 本の
  結果が順に出る（生成結果 / 割れている base / 未認識の View / 対象データセットと
  suffix / データセット別の View 数 / View 名の条件で落ちた View /
  条件から外れたデータセット / 構成が変わった日）
- **セクション 1 は `CREATE OR REPLACE TABLE`。** 実行すると既存の行が消える
  （パーティションに積んだ履歴も含めて）。スキーマを変えたときに確実に作り直せる
  かわり、うっかり流すと履歴が飛ぶ。日次の生成には含まれない
- 生成器は書き出す前に、`FORMAT` の書式に `%s` 以外の `%` が無いか、`r"""` の
  対応が取れているか、旧いプレースホルダが残っていないかを検査する
- **`node check_sql.mjs` が 2 つの SQL の食い違いを見つける。** 使っている目印が
  関数側で展開できるか、4 手の型が崩れていないか、`render_call_sql` の書式と
  引数の数が合うか、UDF 名の組み立てが両ファイルで同じかを突き合わせる

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
  FROM `__TARGET_PROJECT__.region-__JOB_REGION__.INFORMATION_SCHEMA.VIEWS`
  WHERE (__VIEW_DATASET_COND__) AND (__VIEW_NAME_COND__)
),
```

**識別子と正規表現はテキスト置換、配列と JSON は `USING` のパラメータ**という
使い分けになる。正規表現をパラメータで渡さないのは、BigQuery の `REGEXP_*` が
パターンに定数を要求しうるため。

```sql
EXECUTE IMMEDIATE rendered_sql
USING suffix_list AS suffix_list, analyze_options AS analyze_options;
```

絞り込みの手段は 3 つ。上から順に「普段」「テスト」「例外」。

絞り込みは上の 4 つの配列に集約してある。

**CONFIGURATION の末尾に事前チェックを置いてある。** 対象 View が 0 件、または
suffix を持つデータセットが 0 件なら `ASSERT` で止まる。黙って空のテーブルを作ると
ロケーションや `analysis_*_patterns` の間違いに気づけないため。
名前が不正（ハイフンや未置換の `{project_token}`）な場合、`analyze_options` が
JSON オブジェクトの形をしていない場合も、同じく `ASSERT` で止まる。

注意しておくこと:

- **条件に一致するが無関係な View を持つデータセットも対象に入る。**
  base ごとに束ねるので混ざりはしないが、1 View だけの base が並ぶ。
  include / exclude で絞れる
- `INFORMATION_SCHEMA.VIEWS` はリージョン単位で読むので、**そのリージョンの
  View 定義をすべて読む権限が要る**

## 事前生成テーブル（build_table.sql）

`build_table.sql` は手で編集するファイル。設定は CONFIGURATION の `DECLARE` だけ。

Looker の操作のたびに UDF を回すのは重いので、スケジュールドクエリで作り置きする。
`INFORMATION_SCHEMA` の中身は View をデプロイしたときしか変わらない。

```
viewlgc_t_diff_hist  PARTITION BY snapshot_date CLUSTER BY base, ref_index
  base / ref_index / ref_label
  view_count / group_count / has_multiple
  group_labels / group_sizes / suffixes / unmatched_count / diff_html
```

Looker Studio はビューを読むだけ。`diff_html` を Templated Record に渡す。
パラメータもカスタムクエリも UDF も不要。

### 基準は行として持つ

**どのグループを基準（左ペインに出しっぱなしにする側）にするかは、
行の粒度で表す。** `base × 基準` で 1 行あり、基準はレポートのプルダウンで選ぶ。
比較相手の選択は今までどおりカード内のタブ。

JavaScript が使えない以上、切り替えられるのは「作り置きしてある絵」だけ。
全組み合わせを 1 レコードに詰めることもできるが、**表示していないぶんも
ブラウザが読む**ことになる。実測（96 行の SQL、class モード）で比べると：

| | 1 レコードの大きさ（G=4） | 1 レコードの大きさ（G=6） |
|---|---|---|
| 全ペアを 1 レコードに詰める | 400 KB | 990 KB |
| 基準ごとに 1 行（この設計） | 100 KB | 165 KB |

ペア 1 枚がおよそ 33 KB で、枚数に対して線形。BigQuery に置く総量はどちらも
同じ G(G−1) 枚なので、**違うのはブラウザに届く量だけ**。

行数は Σ グループ数。100 base・平均 3 グループなら 1 スナップショット 20 MB
程度で、保持日数の既定（400 日）でも BigQuery としては小さい。

**「なぜ別グループになったか」も基準ごとに出し分ける。** 解析側が全順序対の
「最初の差」を `missBy` として返し、描画側が選ばれた基準の列を読む
（向きによって理由が変わりうるので対称にはしていない）。グループ数はせいぜい
数個なので、G² でも走査は実質ゼロ。

パーティションに日付を積むので**履歴が残る**。「いつグループ構成が変わったか」を
後から追えるので、ロジック逸脱の検知に使える（`build_table.sql` の末尾に例あり）。

base の切り出しと UDF に渡す `suffixList` は、同じ 1 つの `suffixes` から作る。
別々に持つ場所がないので、ズレようがない。

## Looker Studio への配線

事前生成テーブルができていれば、あとは読むだけ。

1. **データを追加 → BigQuery** でビューを選ぶ
   （カスタムクエリではなくテーブル選択でよい）
   - 基準を切り替えないなら `viewlgc_vw_t_diff`
   - 切り替えるなら `viewlgc_vw_t_diff_by_ref`
2. **Templated Record** を配置し、表示対象のカラムに `diff_html` を指定
3. **コントロール → プルダウン リスト**を置き、コントロール フィールドに `base`。
   **「単一選択にする」をオン**（1 レコード＝1 base を表示するため）
4. `viewlgc_vw_t_diff_by_ref` を使う場合は、`ref_label` のプルダウンをもう 1 つ置く。
   こちらも**単一選択**。base と 2 つそろって 1 レコードに決まる
5. `mode='class'` で生成した場合は、テンプレートに CSS を貼る

CSS は **`template_style.html`**（`build_udf.mjs` の生成物）をそのまま貼るか、
BigQuery から取る。中身は同じ。

```sql
SELECT `<project>.<udf_dataset>.viewlgc_group_css`('{"mode": "class"}');
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
