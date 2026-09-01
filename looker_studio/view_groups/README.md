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
| `note_preview.html` | `build_udf.mjs` の生成物。メモの下書き用。ブラウザで開くだけで使える |

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
node preview.mjs          # dist/preview.html を生成して検証（110 アサーション）
node preview.mjs --check  # 生成せず検証だけ
```

## BigQuery UDF（view_group_html.sql）

```bash
node build_udf.mjs          # 検証して view_group_html.sql を生成
node build_udf.mjs --check  # 生成せず検証だけ（54 アサーション）
node check_sql.mjs          # build_table.sql と view_group_html.sql の突き合わせ
```

| 関数 | 戻り値 |
|---|---|
| `viewlgc_analyze(views, options_json)` | 解析結果の JSON（`viewCount` / `groupCount` / `groupLabels` / `groupSizes` / `suffixes` / `unmatchedCount` / `bases`） |
| `viewlgc_render(analysis_json, options_json)` | ロジック差分のカード |
| `viewlgc_erd(analysis_json, options_json)` | 参照関係の図（それだけ。束ねない） |
| `viewlgc_page(analysis_json, diff_html, erd_html, columns_json, sql_json, options_json)` | カラム定義の表と View ごとの素の SQL を作り、メモ（目印のみ）・差分・図と外側タブで束ねた 1 枚 |
| `viewlgc_markdown(md)` | base ごとのメモ（Markdown）の HTML。**ビューの中から呼ぶ** |
| `viewlgc_group_css(options_json)` | `mode='class'` でテンプレートに貼る CSS。**SQL 関数で、生成時に焼き込んだ固定文字列を返す**（`options_json` は見ない） |
| `viewlgc_render_dynamic_sql(sql_template, …)` | `build_table.sql` の `__…__` を展開した SQL（JavaScript ではなく SQL 関数） |

### 解析と描画は別の UDF に分ける

**インラインのコード ブロブは 1 個あたり 32 KB までに制限される（標準 SQL でも
同じ）。** 1 本にまとめると枠が 1 つしか使えず、実際 29.3 KB まで詰まっていた。
依存は素直に割れる（解析は `analyze.js` だけ、描画は `diff` / `render` /
`render_groups` だけ）ので、2 つの UDF に分けて枠を 2 つ使う。

```
viewlgc_analyze     素 23.7 KB → 最小化 10.7 KB（上限比 36%）
viewlgc_render      素 45.8 KB → 最小化 27.5 KB（上限比 92%）
viewlgc_erd         素 34.7 KB → 最小化 16.2 KB（上限比 54%）
viewlgc_page        素 27.9 KB → 最小化 13.5 KB（上限比 45%）
viewlgc_markdown    素 11.1 KB → 最小化  6.5 KB（上限比 22%）
```

（`viewlgc_group_css` は JavaScript ではなく SQL 関数になったので、この枠とは
無関係。生成時に焼き込んだ固定文字列を返すだけ。）

**枠を空けるのは `UNUSED_*` の見直しが最初の手。** ファイルを共有している都合で、
その UDF が呼ばないものまで付いてくる。実際、`viewlgc_page` は CSS を返す関数
（`columnsCss` / `sqlCss`）を積んでいて 98% まで来ていたが、CSS を配るのは
`viewlgc_group_css` の仕事なので落として 87% に戻った。`viewlgc_render` も
外枠で束ねる `wrapPage`（page の仕事）を落としている。

> `dropFunctions` はバンドル末尾の関数も落とせる。閉じ括弧のあとの改行を
> 必須にしていた頃は、最後のファイルの最後の関数だけ「見つかりません」で
> 落ちていた（`strip` が末尾を trim するため）。

**`viewlgc_erd` を `viewlgc_page` から割ったのはこのため。** 図を描くには SQL の
トークナイザ（`analyze.js`）が要り、それだけで最小化後 9 KB ある。同居させて
いた頃は 1 本で 27.7 KB（92%）まで来ていて、カラム定義に手を入れるたびに枠を
気にすることになっていた。依存が独立している場所で割れば、両方に余裕ができる
（54% と 45%）。

残るは `viewlgc_render` の 92%。CSS を足すときは
`node build_udf.mjs` の最後に出るサイズを見ること。**メモの CSS を
`markdown.js` の `memoCss()` に置いてあるのはこのため**で、差分側の
`chromeCss()` に混ぜると `viewlgc_render` にも使わない CSS が乗る。
配る 1 枚は `viewlgc_group_css` が両方を連結して作る。

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
DECLARE suffix_extra_list ARRAY<STRING> DEFAULT [];       -- 自動抽出に足す suffix
DECLARE snapshot_time_zone STRING DEFAULT 'Asia/Tokyo';   -- snapshot_date の基準

-- [B] 既定のままで動くもの
DECLARE suffix_pattern      STRING        DEFAULT r'_([A-Za-z]{4})$';
DECLARE suffix_list         ARRAY<STRING> DEFAULT [];  -- 書くと自動抽出を置き換える
DECLARE suffix_tail_lengths ARRAY<INT64>  DEFAULT [2];
DECLARE suffix_exclude_list ARRAY<STRING> DEFAULT [];
DECLARE analyze_options     STRING        DEFAULT '{"mode":"class"}';

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
| `table_diff` | 生成結果のテーブル（最新の 1 世代だけ） | `viewlgc_t_diff` |
| `table_base_note` | base ごとのメモ（スプレッドシートの外部テーブル） | `viewlgc_m_base_note` |
| `view_diff` | レポートが読むビュー。メモを差し込む | `viewlgc_vw_t_diff` |
| `udf_analyze_function_name` | View 群を解析して JSON を返す UDF | `viewlgc_analyze` |
| `udf_render_function_name` | その JSON を比較 HTML にする UDF | `viewlgc_render` |
| `udf_page_function_name` | 参照関係を作り差分と束ねる UDF | `viewlgc_page` |
| `udf_markdown_function_name` | メモの Markdown を HTML にする UDF | `viewlgc_markdown` |
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

テーブルとビューは基本名が同じ `diff` で、`vw_` の有無だけで見分ける。

> 以前はテーブルだけ `_hist` が付いていた（日次スナップショットを積んでいた頃の
> 名残）。履歴をやめたときに落とした。名前を変えても古いオブジェクトは残るので、
> `build_table.sql` のセクション 1 に `DROP` の手順を書き添えてある。

`build_table.sql` の設定は次のとおり。ここが唯一の置き場所で、書き換えたら
そのまま実行する。生成の手順はない。

| 変数 | 役割 |
|---|---|
| `analysis_include_dataset_patterns` | 対象データセット。空配列ならリージョン内すべて |
| `analysis_exclude_dataset_patterns` | 落とすデータセット。include のあとに効く |
| `analysis_include_object_patterns` | 対象 View 名（`table_name`）。空配列なら絞らない |
| `analysis_exclude_object_patterns` | 落とす View 名。include のあとに効く |
| `suffix_pattern` | データセット名から suffix を切り出す正規表現（1 つ目のキャプチャ） |
| `suffix_list` | suffix 一覧を丸ごと自分で決める。**書くと自動抽出は行われない（足すのではなく置き換える）** |
| `suffix_extra_list` | 一覧に**足す** suffix。自動抽出はそのまま残り、末尾の導出は掛からない。1 つだけ強制的に足したいときはこちら（[A]） |
| `suffix_tail_lengths` | 取り出した suffix の末尾 n 文字も suffix として扱う。既定の `[2]` で `abjp` → `jp` |
| `suffix_exclude_list` | suffix 一覧から落とす値（正規表現ではなく完全一致） |
| `include_nested_fields` | カラム定義に STRUCT の中身を行として出すか（既定 `TRUE`） |
| `snapshot_time_zone` | `snapshot_date`（いつ時点の内容か）の基準タイムゾーン。リージョンごとに変える（[A]） |
| `analyze_options` | UDF に渡す解析オプション（JSON）。`substitutable` などをここで足せば再生成が要らない |
| `note_sheet_url` | base ごとのメモを置くスプレッドシートの URL（[A]）。空ならメモを使わない |
| `note_sheet_range` | その中の読み取り範囲。既定 `notes!A:E`（[A]） |

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
CREATE OR REPLACE TABLE `__T_DIFF__` … AS SELECT …
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
- **スケジュールドクエリには CONFIGURATION と セクション 2・3・3b を登録する。**
  設定ブロックが無いと変数が未定義になる。1 は初回だけ、4 と 5 は確認用なので不要
- **セクション 5 の確認クエリは実行される。** ファイルを丸ごと流すと 8 本の
  結果が順に出る（生成結果 / 割れている base / 未認識の View / 対象データセットと
  suffix / データセット別の View 数 / View 名の条件で落ちた View /
  条件から外れたデータセット / メモの登録状況）
- **セクション 1 が作るのはメモの置き場所だけ。** 差分のテーブルはセクション 2 が
  毎回作り直すので、先に用意しておく必要がない。初回もセクション 2 だけで揃う
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
1 つの文の中で、同じ条件から両方を引く。

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
viewlgc_t_diff_src  CLUSTER BY base（素のカード。メモ差し込み前）
  snapshot_date / base / ref_index / ref_label
  view_count / group_count / has_multiple
  group_labels / group_sizes / suffixes / unmatched_count
  view_desc_md / diff_html

viewlgc_vw_t_diff  上から ref_index / ref_label を除き、次を足したもの
  has_note / has_view_desc / note_md / note_html
  note_updated_at / note_updated_by
  diff_html は目印をメモに差し替え済み。**シートの内容がその場で出る**

viewlgc_t_diff  SELECT * FROM viewlgc_vw_t_diff を焼き込んだもの
  **レポートが読むのはこれ**
```

Looker Studio はビューを読むだけ。`diff_html` を Templated Record に渡す。
パラメータもカスタムクエリも UDF も不要。

### 持つのは最新の 1 世代だけ

以前は `PARTITION BY snapshot_date` で日次スナップショットを積み、「いつグループ
構成が変わったか」を追えるようにしていた。実際には使い道が無かったので、
**テーブルごと差し替える形に変えた**。

```sql
CREATE OR REPLACE TABLE `__T_DIFF__` ( … ) CLUSTER BY base OPTIONS ( … )
AS WITH … SELECT …
```

**`DELETE` + `INSERT` に戻してはいけない。** 履歴があった頃はビューが
`MAX(snapshot_date)` を採っていたので、消してから入れるまでの隙間に
レポートを開いても前日分が出ていた。最新しか持たない以上、その隙間は
**何も出ない時間**になる。`CREATE OR REPLACE TABLE ... AS SELECT` は 1 文で
差し替わるので、読み手からは古い内容か新しい内容のどちらかしか見えない。
`TRUNCATE` + `INSERT` も同じ理由で不可。`node check_sql.mjs` が見張る。

列の説明（`OPTIONS(description = …)`）は CTAS の列リストに書く。スキーマを
明示できるので、作り直すたびに説明が消えることはない。**列リストと `SELECT` の
並びが食い違うと BigQuery が落とす**ので、`check_sql.mjs` が両者の列名を
順番まで突き合わせる。

#### ビューで繋いで、テーブルに写す

生成は 3 段。

```
セクション 2    INFORMATION_SCHEMA → 解析 → 描画 → viewlgc_t_diff_src
セクション 3    viewlgc_vw_t_diff = t_diff_src ＋ メモ（シート）  ← その場で出る
セクション 3b   viewlgc_t_diff    = SELECT * FROM vw_t_diff       ← レポートが読む
```

**ビューをそのままレポートに読ませると遅い。** 開くたびに

- スプレッドシートの外部テーブル（Drive）を読み
- JS UDF で Markdown を HTML にし
- 数 MB の `diff_html` に `REPLACE` をかける

ことになる。だからテーブルに写して、レポートはそちらを読む。

**それでもビューを残すのは、シートを直した内容をその場で確かめられるから。**
メモを直したあと 3b を流す前でも、`vw_t_diff` を見れば反映後の姿が分かる。

> **メモを繋ぐ書き方はビューの定義 1 か所だけ。** 焼き込みは `SELECT *` で
> 写すだけにしてある。同じ SQL を 2 か所に書くと、片方だけ直したときに
> 「レポートには出るがリアルタイムには出ない」ような食い違いが起きる。
> `node check_sql.mjs` が見張る。

**シートを直したその場でレポートに反映したいときは、セクション 3b だけを
流し直す**（解析も描画もやり直さないので軽い。読むのは `t_diff_src` と
シートだけ）。待てるなら翌日の日次実行でも同じ結果になる。

### 基準はカードの中で選ぶ

**基準（左ペインに出しっぱなしにする側）が意味を持つのはロジック差分だけ。**
カラム定義は全グループを横に並べるので基準を立てる必要がなく、参照関係は
構造そのものを積むだけなのでやはり要らない。だから基準の選択は**ロジック差分の
中に置く**（外側タブのすぐ下に `基準グループ` のタブが出る）。

そのぶん **1 レコードには基準ごとの比較が全部入る**。比較の枚数は G×(G−1) で
効き、1 枚の大きさは SQL の長さにほぼ比例する（実測で 100 行なら 30 KB 前後、
500 行なら 500 KB 前後）。

```
100 行  G=3   6 枚  約 200 KB
100 行  G=4  12 枚  約 400 KB
500 行  G=3   6 枚  約   3 MB
```

**`REF_BUDGET`（40 MB）は「重くしない」ための値ではなく、「行が壊れない」ための値。**
グループが極端に多い base が 1 つ紛れ込むと、1 行が BigQuery の上限
（クエリ結果の 1 行 100 MB）を超え、**日次の生成ごと落ちる**。カードが
欠けるよりパイプラインが止まるほうが困るので、そこだけは止める。

実測（あるプロジェクトの全 base）で、基準 1 つぶんの最大が 690 KB・大半は
490 KB 以下だった。500 行の SQL × 6 グループを組んでも 15 MB で、40 MB には
1 桁足りない。**通常の運用で当たることはない。**

> はじめ 600 KB にしていたところ、500 行 × 3 グループで通常の運用のまま当たり、
> 「基準タブが 1 枚しか出ない」という故障と見分けの付かない形で表に出た。
> 見積もりで決めるとこうなるので、いまの値は実測に合わせてある。

打ち切ったときは理由とそこまでの大きさを画面に出す。1 枚目は予算を超えても
必ず載せる（空のカードを出すよりましなので）。

> 差分を短くする手立て（変更行の前後だけ描く `contextLines` など）は
> `templated_record` 側の `render.js` にはあるが、こちらがベンダリングして
> いる `ddl_diff_viz` 側には無い。効かせたければまずそちらの移植から。

> **以前は `base × 基準` で行を分けていた。** 基準ごとに 1 レコードにすると
> ブラウザに届く量は G 分の 1 で済むが、切り替えのたびに再クエリが要り、
> レポートに `ref_label` のコントロールを置く必要があった。基準がロジック差分
> だけの概念だと整理できた時点で、カードの中に入れるほうが素直になった。
> BigQuery に置く総量はどちらも同じ G(G−1) 枚で変わらない。

`ref_index` / `ref_label` の列はテーブルに残してある（常に 0 と先頭グループの
ラベル）。消すとレポート側でその列を使っているチャートが壊れるため。
`*_once` の列も同じ理由で残っているが、行が増えなくなったので
`group_count` などをそのまま使ってよい。

**「なぜ別グループになったか」は基準ごとに出し分ける。** 解析側が全順序対の
「最初の差」を `missBy` として返し、描画側が基準ごとにその列を読む
（向きによって理由が変わりうるので対称にはしていない）。グループ数はせいぜい
数個なので、G² でも走査は実質ゼロ。

タブは 4 段になる（SQL タブの中は外側の 1 段下なので、深さとしては 2 段目）。
クラスはすべて分けてある。同じクラスだとどれかのラジオが別の段の
`:checked ~` に引っかかる。

| 段 | クラス | 中身 |
|---|---|---|
| 外側 | `.vg-or* / .vg-ot* / .vg-op*` | note / カラム定義 / 参照関係 / ロジック差分 / SQL |
| 基準 | `.vg-br* / .vg-bt* / .vg-bp*` | どのグループを基準にするか |
| 比較 | `.vg-r* / .vg-t* / .vg-p*` | 基準と見比べる相手 |
| SQL | `.vg-sr* / .vg-st* / .vg-sp*` | どの View の素の SQL を出すか |

> **比較タブのラジオは基準ごとに `name` を変える。** 同じ名前だと全基準の
> ラジオが 1 つの組になり、選ばれていない基準の比較タブがどれも開かなくなる。
> `idPrefix` に基準の番号を混ぜてある。

### 参照関係の図（ERD タブ）

カードは**外側のタブ 5 枚**でできている。左から `note` / `カラム定義` /
`参照関係` / `ロジック差分` / `SQL` で、既定で開くのは `note`。1 レコードに全部入れてあるので、
`base` のコントロール 1 つでどのタブも決まる。別のチャートに分けると、
コントロールを何組もそろえる必要が出て、片方だけずれた状態を作れてしまう。
枚数と順序は `chrome.js` の `OUTER_TABS` がひとつの決め所で、CSS の規則も
そこから作る。

**見出し（base 名 / View 数 / グループ数）とタブは 1 枚の帯にまとめ、
スクロールしても残す**（`position:sticky; top:0`）。カードは縦に長いので、下まで
読んでから別のタブへ移るのにいちばん上まで戻るのは面倒だし、何の base を見て
いるのかも見えていてほしい。

差分側（`renderBase`）も参照関係側（`renderErdBase`）もそれぞれ自分でも
`header()` を出す。単体で使うときのためのもので、束ねたときは
`.vg-opanel .vg-header{display:none}` で隠して帯の 1 枚に集約する。

#### 外枠の CSS は「配った全世代のカード」で効くように書く

**ここは二度実機で踏んだ落とし穴なので、変えるときは必ず読むこと。**

テンプレートの CSS は**手で貼る**。カードの HTML は**日次で作り直す**。この 2 つは
別々に配られるので、**世代がズレた状態が必ず生まれる**。片方の世代を決め打ちに
した CSS を配ると、実機では「タブが反転しない」「帯が固定されない」が同時に起き、
しかも画面からは CSS と HTML のどちらが古いのか分からない。

これまでに配った外枠は 2 通りあるので、選択中のタブを塗る規則は両方を並べて書く。

```css
.vg-orN:checked ~ .vg-otablist > .vg-otN,
.vg-orN:checked ~ .vg-ohead > .vg-otablist > .vg-otN { … }
```

| 世代 | 外枠 |
|---|---|
| 見出しがパネルの中／帯の中 | `.vg-outer > .vg-otablist > .vg-otN` |
| 見出しを `.vg-ohead` で包んだ世代 | `.vg-outer > .vg-ohead > .vg-otablist > .vg-otN` |

**どれも「兄弟 > 子（> 子）」で、子孫結合子や `*` は使わない。** この viz で
radio + `:checked` が動くことを確かめたときの形が子結合子だから
（`templated_record/samples/07_radio_tabs_test.html`）。

**規則は「いま並べる枚数」ではなく `MAX_OUTER_TABS`（8 枚）ぶん出す。** ズレは
もう一方向にも起きるため。順序はいつも「カードが先・CSS が後」なので、タブを
1 枚足すと、貼り替えるまでの間 **タブは出るのに中身が出ない**（そのタブを開く
規則が CSS に無い）。押しても反転しない空欄になるので、故障と見分けが付かない。
実際に SQL タブを足したときに出した。使う予定のない番号の規則を出しておいても
要素が無ければ何も起きないので、2 行 × 数枚ぶんと引き換えに、**次にタブを
足すときはカードだけ貼り替えれば動く**。

> 症状から見分けるには、そのタブを押して**反転するか**を見る。反転しなければ
> 中身を出す規則も無い＝CSS が古い。反転するのに空なら、そちらは中身の側
> （`sql_json` や `columns_json` が取れていない）を疑う。

いまの外枠では**見出しを `.vg-otablist` の中に直接置く**。包む入れ物を挟むと
経路が 1 段深くなる。並びは `.vg-otablist` を `flex-wrap` にして、見出しだけ
1 行占有させる。ラジオは `.vg-outer` の直下なので、`.vg-otablist` も
`.vg-opanels` も後ろに続く兄弟になる。

> `preview.mjs` の `CARD_GENERATIONS` に世代を並べてあり、規則が全世代ぶん
> 出ているかを検証している。外枠を変えるときはここに 1 行足す。

> **タブの並び替えは HTML だけの変更。** CSS は番号ごとに対称な規則を出すだけで、
> 見出しも中身も知らない。貼り替えの順序は問わない（新旧どちらの CSS でも
> 見た目は同じで、中身の並びだけが変わる）。

`z-index` は 5 にしてある。0 や `auto` だと、あとに出てくる `position:relative`
の要素（`{{Pn}}` のチップ）が DOM 順で手前に来て帯に重なる。逆に 20 以上に
すると、そのチップの吹き出し（`z-index:20`）が帯の下に隠れる。間を取ると、
地の文は帯が隠し、吹き出しは帯より手前に出る。

**そのために、カード自身を自前のスクロール箱にしている。**

```css
.vg-outer{max-height:min(100vh,2000px);overflow:auto}
```

`position:sticky` は「いちばん近いスクロールする祖先」を基準にする。埋め込み先
まかせにすると、次の 2 つで落ちる。**Looker Studio では実際に両方とも効かなかった。**

| 埋め込まれ方 | 何が起きるか |
|---|---|
| 途中に `overflow:hidden` の祖先がある | 帯はその枠を基準にする。枠自体はスクロールしないので動かない |
| iframe が中身の高さぶん伸び、親ページがスクロール | iframe の中にスクロールする要素が 1 つも無い。`100vh` も中身の高さになるので上限として働かない |

**固定の px を上限に入れておけば、どの形でもこの箱がスクロールする側になる。**
`min()` で `100vh` と併記しているのは、チャートがこれより低いときにはみ出さない
ため（低いチャートでは `100vh`、高いチャートでは `2000px` が効く）。`max-height`
なので、中身が収まればスクロールバーも出ない。

> **2000px はレポートのチャートの高さに合わせて変える値。** テンプレートに貼る
> CSS の中でこの数字だけ書き換えればよく、BigQuery を流し直す必要はない。
> 生成物では `chromeCss()` の `.vg-outer` の行に ★ を付けてある。
>
> 既定を大きめに取ってあるのは、**小さすぎると効いているのが `100vh` 側になり、
> この数字を変えても何も起きなくなる**ため（実際にそれで迷った）。チャートより
> 大きいぶんには `100vh` が上限として働くので、実害が出にくい側に倒してある。

> 想定される 3 通りの埋め込まれ方（ホストの内側 div がスクロールする形、
> ページがスクロールし途中に `overflow:hidden` の枠がある形、iframe が中身の
> 高さぶん伸びて親がスクロールする形）を手元で作り、どれでも帯が貼り付くことを
> 確かめてある。

図は `FROM` / `JOIN` から起こす。節は実体（実テーブル / CTE / サブクエリ）、
辺は「読んで作る」向き。JOIN の種別と結合キーは、読む側へ入る辺の注記にする。

**グループごとの図は縦に積む（タブにしない）。** 差分は「基準と 1 つを見比べる」
ものなので一度に 2 つ出れば足りるが、参照関係は系統ごとの構造そのものなので、
並べて一望できたほうが読みやすく、切り替えの操作も要らない。並びは解析結果の順
そのままで、**ここに「基準」は無い**（基準はロジック差分の中でだけ意味を持つ
考え方なので）。

```
orders_abjp ──▶ base_orders ──▶ tagged ──▶ ranked ──▶ daily ──▶ (最終 SELECT)
customers_abjp ┄┄▶ base_orders          calendar_abjp ──▶ daily
     （EXISTS の相関サブクエリ経由）        （LEFT JOIN / order_date）
```

**これは厳密には ER 図ではなく参照関係図。** SQL からはカーディナリティも
主キーも分からないので描いていない。それらしく描くと、確かめていないことを
確かめたように見せてしまう。1:N を出すなら `TABLE_CONSTRAINTS` /
`KEY_COLUMN_USAGE` から PK/FK を読む必要がある（宣言していれば取れる）。

実装で押さえている点:

- **入れ子のスコープは平らにする。** `EXISTS (SELECT … FROM customers)` や
  `FROM (SELECT …)` の参照は、囲んでいる CTE の入力として扱い、辺を破線にする。
  図でも入れ子にすると読めなくなるうえ、「この CTE は何を読むか」という
  問いには平らな形のほうが答えている
- **図の高さは注記の広がりからも決める。** 注記は辺の中点に置き、行数ぶん
  上下へ広がるので、結合キーが多い辺があると箱の並びの外へはみ出す。同じ段
  どうしをつなぐ辺だと中点が箱の中心と同じ高さになり、上へもはみ出す。箱と
  注記の両方を含む範囲を測り、はみ出したぶんは `viewBox` の原点を負にして
  取り込む（座標を全部ずらすより素直で、箱の位置の計算に手を入れずに済む）
- **箱の幅も段の間隔も、中身に合わせて決める。** SVG のテキストは箱から
  はみ出しても切られないので、幅を固定すると詰めるか重ねるかしか無くなる。
  箱は図の中でいちばん長い名前に、段の間隔はその溝に置く注記のいちばん長い行に
  合わせる。JOIN の種別と結合キーは 1 行ずつに分けるので、幅は自然に収まる
- **段は「できるだけ遅く」置く（ALAP）。** 最長路で前詰めにすると参照テーブルが
  左端に並び、消費する CTE まで線が何段もまたいで箱の上を横切る。消費する側の
  直前に置けば、どの辺も 1 段しかまたがない
- **`{{Pn}}` は先に代表 View の値へ戻してから解析する。** そのままだと
  `{` `{` `P1` `}` `}` の 5 トークンに割れて実体名として読めない
- **SVG は `style` 属性を使わず表示属性で書く。** `style` を使うと
  `mode='class'` がハッシュしてクラス名にするので、CSS を貼り直すまで
  素の見た目になる
- **UDF は差分側と分けてある。** 図の解析にはトークナイザが要るが、差分エンジンと
  一緒に積むとインラインの 32 KB に収まらない。共通の外枠は `chrome.js` に出して
  両方から使う

base の切り出しと UDF に渡す `suffixList` は、同じ 1 つの `suffixes` から作る。
別々に持つ場所がないので、ズレようがない。

#### データセット名に現れない suffix（`suffix_tail_lengths`）

自動抽出は**データセット名**を見る。だから「データセットは `mart_abjp`（suffix =
`abjp`）なのに、その中に `v_x_jp` のように地域だけを持つ View がある」という形は
拾えない。`jp` はどのデータセット名の末尾にも出てこない。

4 文字の suffix が `<系統 2 文字><地域 2 文字>` の組になっているなら、**その後ろ
2 文字がそのまま地域だけの suffix になる**。取り出した suffix から導出する。

```sql
DECLARE suffix_tail_lengths ARRAY<INT64> DEFAULT [2];
DECLARE suffix_exclude_list ARRAY<STRING> DEFAULT ['meta', 'ta'];
```

データセットが `mart_abjp` / `mart_cdjp` / `mart_efjp` / `mart_ghkr` / `ops_meta`
のときの結果。

```
除外なし                  abjp cdjp efjp ghkr jp kr meta ta
ghkr を除外（kr は残る）    abjp cdjp efjp      jp kr meta ta
meta と ta を除外         abjp cdjp efjp ghkr jp kr
```

**除外が要る。** 既定の条件では作業用データセット `ops_meta` から `meta` が
suffix として入っており、末尾 2 文字を足すと `ta` まで増える。混ざったゴミは
**全 View 名**に `ENDS_WITH` で当たるので、`v_summary_ta` のような無関係な View の
base が切られる。**base が変わるとメモが黙って外れる**（メモは `base` の完全一致で
突き合わせている）。エラーは出ない。

**ただし、まず `analysis_exclude_dataset_patterns` を検討すること。** 除外の道具は
2 つあり、役割が違う。

| | 効く範囲 |
|---|---|
| `analysis_exclude_dataset_patterns` | そのデータセットを**丸ごと**対象外にする。名前から suffix を取り出さず（末尾の導出も起きず）、中の View も集めない |
| `suffix_exclude_list` | 出来上がった suffix 一覧から値を落とすだけ。View の集め方は変わらない |

```
除外なし                        suffix: abjp cdjp ghkr jp kr meta ta
                               View  : mart_abjp.v_sales_abjp  mart_abjp.v_sales_jp
                                       mart_ghkr.v_sales_ghkr  ops_meta.viewlgc_vw_t_diff

exclude_dataset = [^mart_ghkr$] suffix: abjp cdjp jp meta ta
                               View  : mart_abjp.v_sales_abjp  mart_abjp.v_sales_jp
                                       ops_meta.viewlgc_vw_t_diff

  + [^ops_meta$]               suffix: abjp cdjp jp
                               View  : mart_abjp.v_sales_abjp  mart_abjp.v_sales_jp
```

作業用データセットはデータセット側で落とすのが筋（`meta` も `ta` も出なくなり、
`viewlgc` 自身の View も対象から消える）。`suffix_exclude_list` が要るのは、
**解析対象にはしたいが名前の語尾が suffix ではない**データセットがある場合だけ。

**除外が効くのは出来上がった一覧に対してだけ**（導出のあと 1 回）。落とした値
からの導出は止まらないので、`ghkr` を落としても `kr` は残る — 「4 文字のほうは
要らないが末尾は要る」が書ける。裏返しに、`meta` と `ta` は両方並べる必要がある
（`meta` だけでは `ta` が残る）。段階を分けて効かせるほうが短く書けるが、書いた値と
消える値が 1 対 1 で対応しないほうが分かりにくい。**5-4 が最終的な一覧を全部
出す**ので、消したいものはそれを見て並べればよい。

> **正規表現ではなく値そのもの**（完全一致）。ここだけ `*_patterns` と流儀が違う
> のは、suffix が短くて部分一致だと巻き添えが大きいため（`ta` を弾くつもりが
> `REGEXP_CONTAINS` では `meta` まで消える）。

**`suffix_pattern` を `r'_([A-Za-z]{2,4})$'` に広げても解決しない。** あれは
データセット名に当たるので、`mart_abjp` からはやはり `abjp` しか出てこない。
そのうえ 2〜3 文字で終わるデータセットの語尾が片端から suffix になる。

#### 強制的に suffix を足す（`suffix_extra_list`）

末尾の導出でも拾えない値 — データセット名にも、その末尾にも現れないもの — を
混ぜたいときはこちら。`mart_abjp` の中に `v_x_global` がある、のような形。

```sql
-- [A] 環境ごとに必ず見るもの
DECLARE suffix_extra_list ARRAY<STRING> DEFAULT ['global'];
```

| | 自動抽出 | 末尾の導出 |
|---|---|---|
| `suffix_list` に書く | **行われなくなる**（置き換え） | 書いた値にも掛かる |
| `suffix_extra_list` に書く | そのまま残る | 掛からない |

`suffix_extra_list` は **[A]（環境ごとに必ず見るもの）** に置いてある。値が環境
ごとに違ううえ、書き忘れると base が静かに変わるため。`suffix_list` のほうは
[B] のまま（一覧を丸ごと自分で決めるときにしか触らない）。

**`suffix_list` は「足す」ではなく「置き換える」。** 1 つ書いたつもりで、
データセット名から取れていた分もろとも消える。エラーは出ず、base の切り出しが
静かに変わるだけなので気づきにくい。一覧を丸ごと自分で決めるとき以外は
`suffix_extra_list` を使う。

`suffix_extra_list` に末尾の導出が掛からないのは、**書いた文字列がそのまま
1 つ増える**ほうが「強制的に足す」の意味に合うから（`global` から `al` が
増えては困る）。除外（`suffix_exclude_list`）は最後に効くので、両方に書けば消える。

どちらの書き方でも、**最終的にどうなったかは 5-4 が全部出す**
（`suffix_origin` にどこから来た値かが入る）。

##### 例: 同じ base に「素の View」と「枝番付きの View」がある

```
mart_abjp.vw_sample_abjp              suffix にしたいのは abjp
mart_abjp.vw_sample_abjp_xyz123456    suffix にしたいのは abjp_xyz123456
```

どちらも base は `vw_sample` にしたい。データセット名（`mart_abjp`）から取れるのは
`abjp` だけなので、枝番付きのほうは自動では拾えない。

```sql
-- [A] 環境ごとに必ず見るもの
DECLARE suffix_extra_list ARRAY<STRING> DEFAULT ['abjp_xyz123456'];
```

これで一覧は `abjp` / `jp` / `abjp_xyz123456` になり、base はどちらも
`vw_sample` に揃う。`vw_sample_abjp_xyz123456` は `_abjp` でも `_jp` でも
終わらないので、自動抽出の値とは競合しない。末尾の導出は extra には掛からない
ので `56` のようなゴミも増えない。

> **suffix に `_` が入るのはこの書き方だけ。** 1 つの View 名に 2 つの suffix が
> 当たりうるようになるので（`zz_abjp` と `abjp`）、**base を決める 2 か所は
> どちらも最長一致**にしてある — SQL の `keyed`（`ORDER BY LENGTH(s.suffix) DESC`）
> と UDF の `extractSuffix`。片方だけ変えると、行の `base` 列とカードの中身が
> 食い違う（エラーは出ない）。`node test.mjs` がこの一致を見ている。

枝番が数個で固定ならこの書き方でよい。**増え続けるなら**、View 名から正規表現で
suffix を取る仕組みが要る（いまは無い。データセット名に対する `suffix_pattern` と
対になるもの）。逆に枝番付きを比べたくないなら、
`analysis_exclude_object_patterns` で対象から外すほうが軽い。

導出し忘れ（新しい地域が増えたなど）は**静かには壊れない**。その suffix を持つ
View は「suffix 未認識」として単独で並び、確認クエリ 5-3 に出る。実際に使われて
いる一覧と、それがどこから来たかは 5-4 で確かめられる。

> **長さの違う suffix を混ぜても取り違えは起きない。** suffix に `_` は入らない
> ので、`v_x_abjp` が `_jp` で終わることはない。1 つの View 名に 2 つの suffix が
> 同時に当たることは原理的に無いので、`abjp` と `jp` を並べて安全。
> （SQL 側は最長一致、UDF 側は一覧順で選ぶが、候補が 1 つしか無いので一致する。）

##### 短い suffix を足す前に、View 名の重複を確かめる

**この作りは View 名がリージョン内で一意である前提。** base の切り出しは
View 名だけで畳んでいる。

```sql
QUALIFY ROW_NUMBER() OVER (
  PARTITION BY src.view_name ORDER BY LENGTH(s.suffix) DESC
) = 1
```

4 文字 suffix（`_abjp` / `_cdjp`）なら View 名にデータセットの区別が入るので
衝突しない。**2 文字を足すとこの前提が崩れうる。** `jp` は `abjp` / `cdjp` /
`efjp` のどれからも導出されるので、`mart_abjp.v_sales_jp` と
`mart_cdjp.v_sales_jp` が同じ名前で並びうる。そうなると 1 本だけ残って
**残りは黙って消える**（カラム定義も `GROUP BY table_name` なので混ざる）。

確認クエリ **5-3b** が重複を出す。**0 件でなければ、その View は正しく扱えて
いない。** その場合は `analysis_include_object_patterns` で対象を絞るか、
データセットまで含めた識別に作りを変える必要がある（未対応）。

### カラム定義（カラム定義タブ）

`INFORMATION_SCHEMA.COLUMNS` から View の出力列を取り、**1 行 = 1 列名、
1 列 = 1 ロジック グループ**の表にする。セルは**型とモード**（`NULLABLE` /
`REQUIRED` / `REPEATED`）。型を大きく、モードはその下に小さく添える。
表記は BigQuery のコンソールに合わせてある。

**並び順（ordinal）は出さない。** 行がその順に並んでいるので番号を添えても
読めるものが増えず、列を 1 本足すと以降がまとめてずれて目障りになるだけ。
グループ内で並び順が食い違ったときだけ `⚠` の内訳（ホバー）に出す
（そこは本物の差なので黙らせない）。

**文字の大きさは重要度どおりに 3 段。** 同じ大きさで並べると、どれを先に読めば
よいかが字面から分からなくなる。

| px | 要素 |
|---|---|
| 12 | 型（セルの本体）/ 列名 |
| 11 | グループ見出し / 説明の値 |
| 10 | 説明の表のキー / 内訳の見出し |
| 8 | モード（`NULLABLE` / `REQUIRED` / `REPEATED`） |

**モードは型の右に置く**（`inline`）。下に積むと 1 行ぶん縦に伸びる。型が長くて
折り返したときは、その末尾に続く。

**型と列名は同じ大きさ。** どちらも行の主役で、型を探すときも列名を探すときも
あるので、片方を落とすと読む順がかえって分かりにくい。

**1px 差は並べても読み取れない。** いちばん弱いモードは 2 段落として 8px に
してある（実機で 11px と 10px を見比べても違いが分からなかった）。

数字を直すときは `preview.mjs` の「文字の大きさが重要度の順になっている」も
合わせる。

**横スクロールはさせない。** 幅は `min(100%, 1000px)` に取り、`table-layout:fixed` と
`<colgroup>` で列名 24%・残りをグループ数で均等割りする。上限を置いているのは、
チャートが横に広いとセルが間延びして読みづらくなるため（`.vg-ctable` の
`max-width` に ★ を付けてある）。

**折り返しは CSS だけに頼らない。** `ARRAY<STRUCT<currency STRING, gross NUMERIC>>`
のような型は空白が少なく、ブラウザから見ると 1 語に近い。`overflow-wrap` や
`word-break` でも折れるはずだが、**この画面では指定した CSS がそのまま効かない
場面を何度か踏んでいる**ので、markup 側にも `<wbr>`（ここで折ってよい、を表す
要素）を `<` と `,` のうしろに入れてある。型の構造の切れ目なので折れても読める。

> 手元で `table-layout:fixed` と CSS の折り返し指定を両方無効にしても、
> `<wbr>` だけで表が枠に収まることを確かめてある。`ARRAY<STRUCT<…>>` の
ような長い型はセルの中で折り返す。横に流すと、右の方のグループを見るのに毎回
スクロールが要って、揃っていない箇所を見つけるという目的に合わない。

**列名の行はスクロールしても残す**（`position:sticky`）。貼り付く位置は
`.vg-outer` の `--vg-bar`（見出し＋タブの帯の高さ、既定 75px）で決める。
包む `div` に `overflow` を置いていないのは、置くとそこが縦のスクロール要素にも
なり、カードのスクロールに対して sticky が効かなくなるため。

グループごとのタブにしていないのは、列名も型も短くて横に並べても収まるから。
全グループを一度に見せれば、どこが揃っていないかをタブを押さずに見つけられる。
SQL は横に長いので差分側は 2 ペインだが、こちらは事情が違う。

**カラム定義はグループではなく View ごとの属性。** 同じロジック グループなら
SQL は α 等価だが、参照先テーブルの型が違えば出力列の型も違う（`amount` が jp は
`NUMERIC`、us は `FLOAT64` など）。**これはロジック差分には出てこない。SQL は
同一だから。** この表のいちばんの値打ちがそこなので、グループの代表 1 本を黙って
出すのではなく、グループの中で食い違ったら必ず印を付ける。

| 見た目 | 意味 |
|---|---|
| 枠（黄）＋ `⚠` | **同じグループの中で揃っていない**（型 / NULL 制約 / 並び順、またはこの列を持たない View がいる）。ホバーで `abus = #4 FLOAT64 NULLABLE` のように suffix ごとの内訳が出る（並び順が見えるのはここだけ） |
| 地色（緑） | 基準グループと**型か NULL 制約**が違う |
| `—`（灰） | そのグループにこの列が無い |

**並び順の違いはグループ間の差として扱わない。** グループが列を 1 本足すと
以降の番号がまとめてずれるので、差にすると本当に見たい型の差がその中に埋もれる。
グループの**中**での並び順の食い違いは `⚠` の対象（同じ SQL なのに順序が違うのは
本物の差なので）。

行の並びは基準グループの `ordinal_position` 順。そこに無い列は後ろに足す。

**列の説明（`COLUMN_FIELD_PATHS.description`）は、列名の欄ではなくグループごとの
セルに出す。** 説明も View に付いた属性なので、グループによって違うことがある
（片方だけ書いてある・文面が更新されている）。1 か所にまとめて出すとその差が
消えるが、セルに置けば型や NULL 制約と同じように横に並んで見える。

グループの**中**で説明が割れていたら、どの View のものかを添えて全部出す
（note タブの View の description と同じ扱い）。1 種類なら見出しは付けない。

##### 説明が JSON なら論理名として読む

BigQuery の `description` は自由文字列なので、日本語論理名と英語論理名のように
**構造を持たせたければ JSON を入れるしかない**。それをそのまま出すと
`{"ja":"受注日","en":"order date"}` と表示されてしまうので、`{` で始まって
JSON として読めたときだけ中身を取り出す。

**JSON だったものは 2 列の表にする。** `key: value` の 1 行で並べると、どこまでが
キーでどこからが値なのかが読み取りにくい（値に `:` が入っていることもある）。

```
{"ja":"受注日","en":"order date"}
    ┌────┬────────────┐
    │ ja │ 受注日      │
    │ en │ order date  │
    └────┴────────────┘

受注日（JST）    → キーが無いので 1 行のまま
{ 壊れた JSON    → 同上
```

**キーは JSON に書いてあった綴りをそのまま出す。** `ja` を `日本語` のように
言い換えると、画面とシートで名前が違うことになり、突き合わせるときに一段
考える手間が増える。並べる順だけ日本語 → 英語 → 残り にそろえる。

> **列幅は決め打ちにしない。キー列はいちばん長いキーの幅になる。** 効かせ方は
> **キーが `white-space:nowrap`・値が `width:100%`** の 2 つだけ。値が残り全部を
> 取るので、キー列はそれ以上詰められない幅＝いちばん長いキーの幅で止まる。
>
> **折り返しを許すと 1 文字まで潰れる。** 値に `width:100%` があるとブラウザは
> キー列を「最小幅」まで詰めようとし、折り返せるならその最小幅は 1 文字になる。
> `overflow-wrap:anywhere` はもちろん、**`break-word` でも同じ**だった
> （Chromium の表レイアウトで 13px まで詰まった）。実際にどちらでも一度出している。
>
> 引き換えに、セルより長いキーははみ出す。10px でいちばん細いセル（6 グループで
> 133px）に入るのは 25 文字ほどなので、実際の綴り（`ja` / `name_ja` /
> `日本語論理名`）では当たらない。実測でキー列は 19px（`ja` / `en`）。

> **キーは太字にしない。** グループ見出し（`.vg-chead`）と同じ太さになって、
> 見出しなのか中身なのかが字面で見分けられなくなる。小ささと色で十分に弱い。

**キー名は決め打ちにしない。** 環境ごとに綴りが違うので、`ja` / `jp` /
`name_ja` / `日本語論理名` / `論理名` などをまとめて受ける（英語側も同様）。
決め打ちにすると、綴りが 1 つ違うだけで論理名が丸ごと出なくなり、しかもエラーは
出ず「説明が空」に見えるだけになる。

**拾えなかったキーも捨てずに表へ並べる。** どう書いても画面から消えないように
するため。認識できたキーは並び順が前に来るだけで、扱いは変わらない。

```
cols_raw     COLUMNS で最上位の列と型（条件文は table_schema / table_name を
             修飾なしで見るので、JOIN する前に単独の CTE で絞る）
col_paths    COLUMN_FIELD_PATHS。STRUCT の中まで 1 行ずつ持っている
col_entries  最上位（cols_raw が軸）とネスト（col_paths）を UNION ALL で 1 本に
cols         View ごとに [{n: field_path, t: 型, o: 並び順, u: is_nullable,
             d: 説明}] へ畳む
base_cols    base ごとに [{v: View 名, cols: […]}] へ畳んで JSON に
```

##### STRUCT の中身は行として展開する

型が `ARRAY<STRUCT<currency STRING, gross NUMERIC>>` のままだと、中の定義が読めない。
`COLUMN_FIELD_PATHS` は**中まで 1 行ずつ持っている**ので、それを行として出す。

```
order_date            DATE REQUIRED
                      ┌────┬────────────┐
                      │ ja │ 受注日      │
                      │ en │ order date  │
                      └────┴────────────┘
tags                  STRING REPEATED
                      タグ
amount_breakdown      RECORD REPEATED
                      通貨ごとの内訳
  └ currency          STRING
                      通貨
  └ gross             NUMERIC
                      税込み金額
```

**親の型はコンソールと同じ `RECORD` / `REPEATED` に畳む。** 中身は子の行に出て
いるので、親にも同じ文字列を並べると場所を取るだけで読めるものは増えない。

| 型 | 表示 | モード |
|---|---|---|
| `ARRAY<STRUCT<…>>` | `RECORD` | `REPEATED` |
| `STRUCT<…>` | `RECORD` | `NULLABLE` / `REQUIRED` |
| `ARRAY<STRING>` | `STRING` | `REPEATED` |
| `STRING` | `STRING` | `NULLABLE` / `REQUIRED` |

**畳むのは、畳んでも定義が読めなくならないときだけ。** `ARRAY<STRING>` は
中身が無いので常に畳めるが、`ARRAY<STRUCT<…>>` は**子の行が出ているときだけ**。
`include_nested_fields = FALSE` のときに `RECORD` へ畳むと、STRUCT の定義が
画面のどこからも読めなくなる。

> スカラーの型名は標準 SQL のまま（`INTEGER` ではなく `INT64`）。コンソールの
> レガシー表記に寄せると SQL タブに出る型と食い違うため、**構造の部分だけ**を
> コンソールに合わせている。
>
> グループ間の比較は**畳む前の型**で行う。`RECORD` 同士でも中身が違えば親の
> セルに色が付き、どこが違うかは子の行で分かる。

セルに入れ子で出したり tooltip に隠したりしないのは、**この表の値打ちが
「グループ間で揃っていないところが列で並ぶ」ことだから**。行に割れば、
`ARRAY<STRUCT<…>>` の長い型を目で比べる代わりに、どのフィールドが違うかまで
色で分かる。`include_nested_fields = FALSE` で最上位だけに戻せる。

**並びは親の型の中での宣言順。** `COLUMN_FIELD_PATHS` に `ordinal_position` は
無い（最上位にしかない）ので、辞書順にするか親の型文字列の出現位置を見るかに
なる。表示している型と並びが一致するほうが読みやすいので後者を採る
（`structFields()` が型を読む。読めなければその項目は後ろへ回す。落とさない）。

**ネストの行には並び順（`#3`）と NULL 制約を出さない。** `ordinal_position` も
`is_nullable` も `COLUMNS` にしか無く、親のものを持ってくると嘘になる。

> 最上位は `cols_raw`（`COLUMNS`）を軸にした `LEFT JOIN`。`COLUMN_FIELD_PATHS`
> が権限などで引けない環境でも、型と NULL 制約だけは出る。軸を逆にすると
> あちらが空のときカラム定義が丸ごと消える。

**事前生成に焼き込む。** メモと違い、カラム定義が変わるのは View をデプロイした
ときだけで、差分やグループ構成と同じ周期。ビューの中で毎回作る理由がない。

> 取れなかった base では、そのタブだけ案内文になる（カード全体は出る）。
> `INFORMATION_SCHEMA.COLUMNS` / `COLUMN_FIELD_PATHS` のリージョン修飾が
> 使えるかは環境によるので、疑わしいときは
> `SELECT COUNT(*) FROM \`region-<location>.INFORMATION_SCHEMA.COLUMNS\`` で確かめる。

### View の SQL そのもの（SQL タブ）

`INFORMATION_SCHEMA.VIEWS.view_definition` を**そのまま**出す。差分も等価判定も
通さない素のテキスト。

**ロジック差分では代わりにならない。** あちらが出しているのは α 等価の判定に
使ったパラメータ化済みの SQL で、実体名や値は `{{Pn}}` に置き換わっている。
何に置き換わったかは末尾の一覧か tooltip を辿れば分かるが、「この View に
実際に何が書いてあるか」を読むための形ではないし、そもそも**グループの代表
1 本ぶんしか出ていない**。

**インナーのタブはグループではなく View（suffix）。** グループは「同じロジックの
束」なので、束の中のどれを見ても SQL は同じ（だから 1 つの束になっている）。
素の SQL を見に来る人が探しているのは「abjp の SQL」であって「グループ 2 の
SQL」ではない。並びは suffix 順で、どのグループに属しているかはパネルの見出しに
出す。上限は `chrome.js` の `MAX_SQL_TABS`（24 枚）。ここだけグループではなく
View 単位なので、同じ base でも枚数が桁ひとつ多くなりうる。

**折り返さない。** SQL は字下げが構造を表しているので、折り返すと読みにくくなる。
横は `.vg-sqlbox` ごとスクロールさせる（カラム定義の表とは方針が逆）。この箱の
中に `sticky` で貼り付く要素は無いので、ここがスクロール要素になっても帯の固定は
壊れない。

**行番号は本文として書く。** CSS のカウンタは埋め込み先で効かなければ番号が
丸ごと消えるが、テキストなら必ず出る。桁は空白でそろえるだけなので、`<pre>` と
等幅フォントがあれば位置も合う。

**解析結果には積まない。** `viewlgc_analyze` が返す JSON から `ddl` は落として
ある（描画に要らないものを UDF 間で運ぶと、サンプル 9 本で 3 KB が 62 KB になる）。
SQL タブぶんは `sql_json` として別に束ねて `viewlgc_page` へ渡す。カラム定義の
`columns_json` と同じ形。

```
analyzed  base ごとに TO_JSON_STRING(ARRAY_AGG(STRUCT(view_name AS v, ddl AS s)))
          → sql_json（解析の CTE と同じ GROUP BY なので、CTE も JOIN も増えない）
```

### base ごとのメモ（Markdown）

`INFORMATION_SCHEMA` から出てこない補足（なぜこの形なのか、いつ何を直す予定か）を
base ごとに添える。元が Confluence の文章なので、見出し・表組・箇条書きが要る。
スプレッドシートのセルに 1 行ずつ書かせるのは書き手の負担が大きいので、
**1 セルに Markdown を書いてもらい、表示側で HTML にする**。

```
スプレッドシート（1 base = 1 行）
  └ Drive
      └ viewlgc_m_base_note（外部テーブル・列は全部 STRING）
          └ viewlgc_vw_t_diff が base で LEFT JOIN
              └ note_html = viewlgc_markdown(note_md)
```

シートの列は左から **`base` / `note_md` / `updated_at` / `updated_by` /
`is_hidden`** の 5 列。1 行目は見出しで、**この順序が唯一の取り決め**
（`skip_leading_rows = 1` なので見出しの文言は見ない）。

| 列 | 中身 |
|---|---|
| `base` | メモを付ける base 名。ビューの `base` と完全一致で突き合わせる |
| `note_md` | Markdown 本文 |
| `updated_at` | 更新時刻（ISO 8601）。同じ base が複数行あるとき、いちばん新しい 1 行だけを採る |
| `updated_by` | 更新者。表示にだけ使う |
| `is_hidden` | `TRUE` / `1` / `yes` なら出さない。消さずに下書きへ戻すためのもの |

##### note タブは View の description ＋ シートのメモ

`note` タブに出るのは 2 つを繋いだもの。**View 自身の `description`（Markdown）が
先で、シートのメモが続く。**

| | 出どころ | 変わるとき |
|---|---|---|
| `view_desc_md` | `INFORMATION_SCHEMA.TABLE_OPTIONS` の `description` | View をデプロイしたとき |
| `note_md` | スプレッドシート | 書き換えたその場で |

区切りは Markdown の水平線。出どころが違うことが読み手に分かるようにする。
**片方しか無ければそれだけを出す**（空のものを落としてから繋ぐので、区切り線
だけが残ることはない）。どちらも無ければ従来どおり「未登録」の枠になる。

`description` は `TABLE_OPTIONS` にしか無い（`VIEWS` にも `TABLES` にも列が無い）。
`option_value` は JSON 文字列の体裁（`"説明文"`）なので剥がして中身を取り出し、
剥がせない形なら生のまま使う。

**base の中で説明が割れていたら、全部出す。** 同じロジックの View なのに説明が
違えばそれ自体が情報なので、黙って 1 つだけ出さない（どの View のものかを
太字で添えて並べる）。1 種類なら見出しは付けない。

ビューが増やす列は `has_note` / `has_view_desc` / `note_md` / `note_html` / `note_updated_at` /
`note_updated_by`。

#### シートの URL とタブ名

`note_sheet_url` には**アドレスバーの URL をそのまま貼ってよい**。
`build_table.sql` が `/d/<ID>` までを切り出して使う。

```
貼る値（どちらでもよい）
https://docs.google.com/spreadsheets/d/1AbCdEfGhIjKlMnOpQrStUvWxYz1234567890/edit?gid=0#gid=0
https://docs.google.com/spreadsheets/d/1AbCdEfGhIjKlMnOpQrStUvWxYz1234567890/edit?usp=sharing

実際に使われる値
https://docs.google.com/spreadsheets/d/1AbCdEfGhIjKlMnOpQrStUvWxYz1234567890
```

切り詰めているのは、`#gid=` が「タブを ID で指定する」意味を持つため。こちらは
`note_sheet_range`（`notes!A:E`）でタブを**名前で**指定しているので、両方あると
指定が二重になる。

**タブ名は `note_sheet_range` の左側と一致させる。** 新規作成した直後のタブは
`シート1` なので、既定の `notes!A:E` のままでは読めない。タブを `notes` に
リネームするか、`note_sheet_range` を `'シート1!A:E'` にする。`A:E` の 5 列が
上の表の 5 列に対応する。

**HTML にするのは事前生成ではなくビューの中。** `diff_html` と同じように
事前生成に焼き込むと、シートを直しても次の日次実行までレポートが古いままになる。
1 件が数 KB の Markdown なので、クエリのたびに変換しても実行時間には響かない。

#### 作り置きのカードに、いま読んだメモを差し込む

メモはカードの**いちばん左のタブ（`note`）**（既定で開く方）に出る。ところがカード自体は
日次で作り置きしていて、メモだけはビューの中で毎回作る。作り置きの側に本体を
埋めることができないので、**外枠だけ先に作って目印を置き、ビューが差し替える**。

```
viewlgc_page が作る（日次）        ビューが毎回やる
<div class="vg-opanel vg-op1">  →  REPLACE(diff_html, '<!--VG_NOTE-->', note_html)
  <!--VG_NOTE-->
</div>
```

目印の文字列は `chrome.js` の `NOTE_MARK` と `build_table.sql` の 2 本のビューで
一致していなければならない。食い違っても**エラーにはならず、メモ タブが黙って
空になる**だけなので、`node check_sql.mjs` が突き合わせる。

`REGEXP_REPLACE` ではなく `REPLACE` なのは、置換文字列の `\1` が後方参照として
解釈されるため。メモは人が書く文章なのでバックスラッシュが入りうる。

> **既にあるスナップショットにはこの目印が無い。** メモ タブを出すには
> セクション 2 を 1 回流して `diff_html` を作り直すこと（流さなければ
> タブが 2 枚のままで、表示が壊れることはない）。

**同じデータソースに載せる**のは、Looker Studio のコントロールが
データソースを跨がないため。別データソースにすると `base` のプルダウンを
2 組そろえることになり、片方だけずれた状態を作れてしまう。

`note_sheet_url` が空のときは、外部テーブルの代わりに**同じ列を持つ空のテーブル**を
作る。ビューの形は変わらないので、メモを使わない環境でもそのまま動く
（`note_html` が「未登録」の枠になるだけ）。あとから URL を入れてセクション 1 を
流し直せば出るようになる。

> **スプレッドシートの外部テーブルを読むには Drive のスコープが要る。**
> スケジュールドクエリを作るときに Drive を許可し、Looker Studio の
> データソースの認証にもそのシートを開ける権限を持たせること。
> シートを共有していない人がビューを引くと、メモだけでなく
> **ビュー全体が権限エラーになる**（`note_sheet_url` を空にすれば回避できる）。

`markdown.js` が対応するのは Markdown の部分集合。

- 見出し（`#`〜`######`）/ 段落 / 罫線 / 引用 / 箇条書き（入れ子可）/ 番号付き
- 表（`|` 区切り。`:--` `:-:` `--:` の寄せに対応）
- コード ブロック（``` / `~~~`）と行内コード
- 強調 `**` `*`、打ち消し `~~`、リンク `[t](url)`

意図して外してあるもの:

- **生の HTML は通さない。** 必ずエスケープしてから組み立てる。書き手は SQL の
  人であってフロントの人ではないので、貼り付けた HTML がカードの CSS を壊したり
  `<script>` が混ざったりするのを避ける
- **`_` を強調に使わない。** メモには `table_name_abjp` のような名前が頻出する
  ので、`_` を強調にすると巻き添えで斜体になる。強調は `*` と `**` だけ
- **画像は読み込まない。** `![alt](url)` はリンクとして出す。カードを開くたびに
  外部のファイルを引きにいくことになるため
- **リンクは `http(s)` と `mailto` だけ。** `javascript:` は素通りさせない
- **段落の中の改行はそのまま `<br>`。** 「空行までは 1 段落」という Markdown 本来の
  規則より、書いたとおりに折り返るほうが書き手の期待に合う

`markdown.js` は依存を持たない素の関数だけで書いてある。BigQuery の UDF に
埋めるのと、あとで編集画面（GAS）にプレビューとして貼るのとで、同じものを使うため。

#### 書く前に見た目を確かめる（note_preview.html）

**`note_preview.html`** を**ブラウザで開くだけ**で、左に書いた Markdown が右に
レポートと同じ見た目で出る。書けたら左の内容をそのままシートの `note_md` の
セルに貼る。BigQuery も Looker も通さずに推敲できる。

`build_udf.mjs` の生成物で、中身は `viewlgc_markdown` と同じ `markdown.js` と
`viewlgc_group_css` が出すメモの CSS そのもの。**ここで見た形がレポートでも
そのまま出る**。外部への読み込みが 1 つも無いので、ファイル単体で開ける。

## Looker Studio への配線

事前生成テーブルができていれば、あとは読むだけ。

1. **データを追加 → BigQuery** で `viewlgc_vw_t_diff` を選ぶ
   （カスタムクエリではなくテーブル選択でよい）
2. **Templated Record** を配置し、表示対象のカラムに `diff_html` を指定
3. **コントロール → プルダウン リスト**を置き、コントロール フィールドに `base`。
   **「単一選択にする」をオン**（1 レコード＝1 base を表示するため）。
   **必要なコントロールはこれだけ。** 基準の選択はカードの中のタブに入っている
4. `mode='class'` で生成した場合は、テンプレートに CSS を貼る

> **`ref_label` のコントロールは外してよい。** 基準がカードの中に入ったので、
> 行は base ごとに 1 本しかなく、このプルダウンには値が 1 つしか出てこない。
メモはカードのいちばん左のタブ（`note`）に出るので、追加のチャートは要らない。本文は
`note_preview.html` をブラウザで開いて下書きし、できた Markdown をシートの
`note_md` に貼る。メモだけを単独で置きたいときのために、`note_html`
（タブの外枠が付かないメモ本体だけ）の列も残してある。

> **`*_once` の列はもう気にしなくてよい。** 基準ごとに行を作っていた頃、
> `group_count` などが行数ぶん膨らむのを避けるために置いた列で、行が base ごとに
> 1 本になったいまは元の列と同じ値になる。既存のレポートを壊さないために
> 残してあるだけなので、新しく作るときは `group_count` をそのまま使う。

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
メモの登録状況は `build_table.sql` の 5-8（`has_note` の一覧と、
「シートにあるのにどの base にも当たらない行」）で見られる。

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
