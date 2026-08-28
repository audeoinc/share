# lnge_vw_t_column_usage_impact — カラム定義書

Looker Studio などでこのビューをデータソースにする方向けの資料です。
**「この列を変更したら、どこの SQL の何行目が影響を受けるか」** を 1 テーブルで引けるように
設計されたビューです。

> 実際のビュー名は環境ごとの prefix / suffix が付きます（既定は `lnge_vw_t_column_usage_impact`）。
> 定義の実体は `sql/setup/01_setup_lineage_environment.sql` にあります。

---

## 1. まずこれだけ：1 行が表すもの

**1 行 = 「起点カラム」 × 「そのカラムが使われている 1 箇所」 × 「そこに至る 1 経路」**

```
origin_*  … あなたが調べたいカラム（＝レポートのフィルタで指定する側）
   ↓ depth 段の依存をたどって
usage_*   … その影響が現れる SQL（View / 生成テーブル）
   ↓ その SQL の中の
line_number / word_number … 具体的な場所
```

読み方の例：

> `origin = sales.orders.amount` を指定すると、
> `amount` を直接参照している SQL（`depth = 1`）と、
> `amount` から派生した列を参照している SQL（`depth = 2, 3, ...`）が
> **場所（行・ワード）付きで**すべて並ぶ。

### depth の意味

| depth | 意味 |
|---|---|
| `1` | **起点カラムそのもの**を直接書いている箇所 |
| `2` | 起点カラムから作られた列を書いている箇所（1 段下流） |
| `3` 以上 | さらに下流。数字が大きいほど起点から遠い |

`depth = 1` の行では `origin_*` と `ref_source_*` が同じ値になります（自分自身を参照しているため）。

---

## 2. ⚠ 最重要：件数を数えるときの注意

**`COUNT(*)` は「箇所の数」になりません。** 必ず読んでください。

### 理由 1：経路ごとに行が増える

`depth >= 2` では、起点から使用箇所までの**経路（`dependency_path`）1 本につき 1 行**できます。
A → B → D と A → C → D のように 2 経路で到達できる場合、**同じ 1 箇所が 2 行**出ます。

### 理由 2：1 つの記述が複数の物理カラムに解決されることがある

`SELECT *` や `COALESCE(a.x, b.x)` のような記述は複数の物理カラムに紐づくため、
**同じ記述位置で複数行**になります。

### 対策：数えたい単位に応じて重複排除する

| 数えたいもの | Looker Studio での指定 |
|---|---|
| 影響を受ける**オブジェクト数** | `usage_object_project` + `usage_object_dataset` + `usage_object_name` の**個別カウント（COUNT DISTINCT）** |
| 影響を受ける**箇所の数** | `usage_object_name` + `line_number` + `column_number` + `usage_type` の組み合わせで個別カウント |
| 単純な行数 | 経路数を含むため、**指標としては使わない** |

Looker Studio では「計算フィールド」で連結キーを作り、それを個別カウントするのが確実です。

```
連結キー（箇所の数を数えたい場合の例）
CONCAT(usage_object_project,'.',usage_object_dataset,'.',usage_object_name,
       '#', CAST(line_number AS TEXT), ':', CAST(column_number AS TEXT),
       '#', usage_type)
```

---

## 3. カラム一覧

列は 5 つのグループに分かれています。**グループ単位で覚えると迷いません。**

### グループ A：origin_* — 調べたいカラム（フィルタで使う）

レポート利用者が「このカラムの影響を見たい」と指定する側です。**フィルタ用**と考えてください。

| カラム | 型 | 意味 |
|---|---|---|
| `origin_project` | STRING | 起点カラムがあるオブジェクトの GCP プロジェクト |
| `origin_dataset` | STRING | 起点カラムがあるオブジェクトのデータセット |
| `origin_object` | STRING | 起点カラムがあるテーブル / View 名 |
| `origin_object_type` | STRING | `TABLE` / `VIEW` |
| `origin_column` | STRING | **起点カラム名** |

### グループ B：usage_* — 影響が現れる SQL（結果として見せる）

その使用箇所を含んでいるオブジェクトです。**レポートの主役**になる列群です。

| カラム | 型 | 意味 |
|---|---|---|
| `usage_object_project` | STRING | 使用箇所を含むオブジェクトのプロジェクト |
| `usage_object_dataset` | STRING | 同、データセット |
| `usage_object_name` | STRING | 同、オブジェクト名 |
| `usage_object_type` | STRING | `VIEW` / `TABLE` |
| `usage_generation_type` | STRING | その SQL の出どころ。下表参照 |
| `usage_definition_hash` | STRING | 解析対象となった SQL 本文のハッシュ。同じ SQL かどうかの判定に使う |

`usage_generation_type` の値：

| 値 | 意味 |
|---|---|
| `VIEW_DEFINITION` | View の定義 SQL |
| `SCHEDULED_QUERY` | スケジュールドクエリが実行した SQL |
| `DAG` | DAG / Airflow が実行した SQL |

> `usage_object_type` は VIEW か TABLE かしか分かりません。
> **「View なのかバッチ SQL なのか」を出し分けたいときは `usage_generation_type` を使ってください。**

### グループ C：場所 — SQL のどこか

| カラム | 型 | 意味 |
|---|---|---|
| `usage_type` | STRING | **どの句で使われているか**。下表参照 |
| `reference_name` | STRING | SQL に書かれていた参照名そのもの（例：`t.amount`） |
| `line_number` | INT64 | 行番号（1 始まり） |
| `word_number` | INT64 | **その行の何番目のワードか**（1 始まり、空白区切り）。インデントの影響を受けない |
| `word_text` | STRING | そのワード自体（例：`t.amount`）。`word_number` の答え合わせ用 |
| `column_number` | INT64 | 元の行における**文字位置**（1 始まり）。インデントを含み、タブは 1 文字扱い |
| `line_text` | STRING | 該当行のテキスト（**行頭インデントは除去済み**） |
| `line_indent_width` | INT64 | 除去したインデントの文字数 |
| `resolution_status` | STRING | 解決状態。実質すべて `PHYSICAL_RESOLVED` |

`usage_type`（＝どの句で使われているか）の値：

| 値 | 意味 |
|---|---|
| `SELECT` | SELECT 句（ウィンドウ関数の `OVER (...)` 内もここに含まれます） |
| `WHERE` | WHERE 句 |
| `JOIN_ON` | JOIN の ON 条件 |
| `GROUP_BY` | GROUP BY 句 |
| `HAVING` | HAVING 句 |
| `QUALIFY` | QUALIFY 句 |
| `ORDER_BY` | ORDER BY 句 |

**場所の見つけ方（おすすめ）**

1. `line_number` で行を特定する
2. `word_number` 番目のワードを数える（`word_text` と一致することを確認）

`column_number` は正確ですが**インデントのスペース・タブを 1 文字ずつ数えた値**なので、
目視には向きません。トリム済みの `line_text` 上の文字位置が必要な場合は
`column_number - line_indent_width` で求められます。

> `word_number` の数え方：`a.amount` の `amount` は「`a.amount` というワードの中」なので、
> `a.amount` が何番目かを返します。人が行を見て探す単位に合わせています。

### グループ D：使用箇所の SQL 全文

| カラム | 型 | 意味 |
|---|---|---|
| `usage_definition_text` | STRING | **使用箇所を含むオブジェクトの SQL 全文**（素のテキスト） |
| `usage_definition_is_current` | BOOL | 下表参照 |
| `usage_definition_html` | STRING | **同じ SQL を、行番号つき・該当箇所ハイライトつきの HTML にしたもの**。第 7 章参照 |

`usage_definition_is_current` の値：

| 値 | 意味 | `usage_definition_text` |
|---|---|---|
| `TRUE` | 解析したときの SQL がそのまま残っている | **入る**。`line_number` がそのまま使える |
| `FALSE` | 解析後にオブジェクトが作り直された | **NULL**（行番号が合わなくなるため、あえて出しません） |
| `NULL` | レジストリに該当オブジェクトが無い | NULL |

`FALSE` の行は、日次パイプラインが次回そのオブジェクトを再解析すれば `TRUE` に戻ります。

> **コストについて**：`usage_definition_text` / `usage_definition_html` は SQL 全文なので
> 大きくなり得ます。ただしビューなので、**これらの列をレポートで使わなければ
> 読み込まれず課金対象になりません。**一覧表には出さず、ドリルダウン用の詳細ページ
> だけで使うのがおすすめです。

### グループ E：経路 — どうやってそこに影響が及ぶか

| カラム | 型 | 意味 |
|---|---|---|
| `depth` | INT64 | 起点からの距離（1 = 直接参照） |
| `ref_source_project` | STRING | **その箇所が実際に参照しているカラム**のプロジェクト |
| `ref_source_dataset` | STRING | 同、データセット |
| `ref_source_object` | STRING | 同、オブジェクト |
| `ref_source_object_type` | STRING | `TABLE` / `VIEW` |
| `ref_source_column` | STRING | 同、カラム名 |
| `ref_source_field_path` | STRING | ネスト型（STRUCT）の場合のフルパス（例：`geo.region`）。通常の列は `ref_source_column` と同じ |
| `dependency_path` | **ARRAY&lt;STRING&gt;** | 起点から使用箇所までの経路。`depth = 1` では NULL |

**`origin_*` と `ref_source_*` の違い**

- `origin_*` = あなたが指定した**調べたいカラム**
- `ref_source_*` = その箇所の SQL に**実際に書かれているカラム**

`depth = 1` なら両者は同じです。`depth >= 2` では、
「`orders.amount`（origin）を調べたら、`summary.total`（ref_source）を参照している SQL が出てきた」
という関係になります。

> ⚠ **`dependency_path` は配列型です。**Looker Studio は配列をそのまま扱えません。
> 使う場合はデータソースをカスタムクエリにして
> `ARRAY_TO_STRING(dependency_path, ' → ') AS dependency_path_text` のように
> 文字列化してください。使わないなら無視して構いません。

---

## 4. レポートの作り方（推奨パターン）

### 前提：必ずフィルタを効かせる

このビューは**起点カラムを絞らずに開くと非常に大きくなります**
（全カラム × 全下流 × 全経路）。レポートには必ず以下を必須フィルタとして置いてください。

- `origin_project` / `origin_dataset` / `origin_object` / `origin_column`

Looker Studio では「コントロール（プルダウン）」を段階的に置き、
最後の `origin_column` まで選ばせてから表を表示する構成が使いやすいです。

### パターン 1：影響サマリー（まず全体像）

- 指標：`usage_object_name` の**個別カウント** … 影響を受けるオブジェクト数
- ディメンション：`depth`、`usage_generation_type`
- 「直接参照が 3 件、2 段下流が 12 件」のような把握ができます

### パターン 2：影響オブジェクト一覧（対応の起点）

- ディメンション：`usage_object_dataset`、`usage_object_name`、`usage_generation_type`、`depth`
- 指標：箇所数（第 2 章の連結キーで個別カウント）
- 並び順：`depth` 昇順 → 直接影響から対応できます

### パターン 3：修正箇所の詳細（実際に直す人向け）

- ディメンション：`line_number`、`word_number`、`word_text`、`usage_type`、`line_text`
- 並び順：`line_number` 昇順
- `line_text` は表の幅を取るので、列幅を広めに確保してください

### パターン 4：SQL 全文のドリルダウン

- パターン 3 の表から遷移する詳細ページで `usage_definition_text` を表示
- 併せて `usage_definition_is_current` を出し、`FALSE` のときは
  「解析後に定義が変わっています」と注意書きが出るようにすると親切です

---

## 5. データの鮮度と注意点

| 項目 | 内容 |
|---|---|
| **更新タイミング** | 日次パイプライン（`03_run_daily_lineage_pipeline.sql`）の実行時 |
| **スナップショット** | 影響グラフは毎回**全件置き換え**。ビューは常に最新のみを返し、履歴は持ちません |
| **対象範囲** | パイプラインの設定で解析対象に含まれるオブジェクトのみ。除外設定されたデータセット / オブジェクトは出てきません |
| **解決できなかった参照** | このビューには**出てきません**。物理カラムに解決できた参照だけが記録されます |

### 既知の制限

- **循環参照**：A → B → A のような循環経路も行として含まれます。現時点でビューには循環を示す列が無いため、
  `dependency_path` に同じオブジェクトが 2 回出てくる行がこれに当たります。
- **`usage_definition_text` の鮮度**：上記のとおり、解析後に定義が変わったオブジェクトでは NULL になります。

---

## 6. SQL をハイライト表示する（`usage_definition_html`）

`usage_definition_text` をそのまま `<pre>` で出すと、行番号が無く、どこが該当箇所か
分かりません。`usage_definition_html` は同じ SQL を**表示用の HTML** にした列です。

- 各行に**行番号**が付く
- **該当行**が背景色で光る（左端にもバーが出る）
- **該当箇所**が文字単位でハイライトされる
- SQL の**構文ハイライト**（予約語・リテラル・コメント）が付く

### ⚠ ハイライトされるのは「1 箇所」ではなく「関連する全箇所」

この列は、**同じ起点カラム × 同じオブジェクト × 同じ定義**の行をまとめて見て、
**そのオブジェクト内の関連箇所を全部ハイライトします**。

つまり、あるオブジェクトが起点カラムを 5 箇所で使っていれば、**5 箇所すべてが光った
同じ HTML** が、その 5 行すべてに入ります。1 レコードだけ表示する Templated Record で
使うことを想定した作りです。

集約はレポートのフィルタが効いた**後**に行われるので、`origin_column` を絞れば、
その起点に関係する箇所だけがハイライトされます。

### Looker Studio での設定

コミュニティ ビジュアライゼーション **Templated Record** を使います
（ギャラリー掲載品なので公開元がホストしており、GCS バケットを公開する必要がありません）。

1. Templated Record を配置する
2. **表示対象のカラムに `usage_definition_html` を指定する**
3. フィルタで `origin_*` を 1 つのカラムに、`usage_object_*` を 1 つのオブジェクトに絞る
   （1 レコード表示なので、絞らないと最初の 1 件しか見えません）

既定では `<style>` を同梱した**自己完結の HTML** を返すので、テンプレート側に CSS を
貼る必要はありません。

### 見た目を変えたい / サイズを削りたい場合

ビューは既定オプションで UDF を呼んでいます。変えたい場合は、カスタムクエリで
UDF を直接呼んでください。

UDF は他の UDF（`lnge_analyze_json` など）と同じ **UDF 用データセット**にあります。
ビューがあるリポジトリ データセットとは別なので注意してください。

```sql
SELECT
  v.*,
  `PROJECT.UDF_DATASET.lnge_usage_sql_html`(
    v.usage_definition_text,
    [FORMAT('%d:%d:%d', v.line_number, v.column_number, LENGTH(v.reference_name))],
    '{"mode":"class","contextLines":10}'
  ) AS custom_html
FROM `PROJECT.REPOSITORY_DATASET.lnge_vw_t_column_usage_impact` AS v
```

| オプション | 既定 | 内容 |
|---|---|---|
| `mode` | `embed` | `embed` `<style>` 同梱で自己完結／`class` markup のみ（**最小**。CSS は下記）／`inline` すべてインライン CSS |
| `contextLines` | なし（全文） | 該当行の前後 N 行だけ描画する |
| `maxLines` | `5000` | 描画する最大行数。超えた分は省略する |
| `fontSize` / `lineHeight` | 12 / 1.45 | |
| `colors.hitBg` / `.markBg` / `.hitBar` ほか | | 該当行の背景・該当箇所の背景・左バー |
| `syntax.keyword` / `.literal` / `.comment` | | 構文ハイライトの色 |

`mode='class'` にすると HTML が小さくなります。その場合はテンプレートに CSS を貼ります。

```sql
SELECT `PROJECT.UDF_DATASET.lnge_usage_sql_css`(NULL);
```

出力を `<style> … </style>` で囲んでテンプレートに貼ってください。
**色やフォントを変えた場合は、CSS 側にも同じ options_json を渡して作り直すこと。**

### 注意点

- **1 行の生成 SQL**：DAG が実行する SQL は改行が無く 1 行だけ、ということがよくあります。
  その場合、行番号は常に 1 になり行ハイライトは意味を持ちませんが、**該当箇所の
  ハイライトは効きます**（折り返して表示されます）。
- **`usage_definition_text` が NULL のとき**（`usage_definition_is_current` が `TRUE` 以外）は
  この列も空文字になります。
- **生成テーブル（`usage_generation_type` が `DAG` / `SCHEDULED_QUERY`）の SQL は、
  `CREATE … AS` の前置きが取り除かれた本体**です。したがって `line_number` は本体の
  1 行目から数えた番号で、実際のジョブ SQL とは前置きの行数だけずれます。View
  （`VIEW_DEFINITION`）は元から本体だけなのでずれません。
- **ハイライトの終端**は `reference_name` の文字数で決めています。バッククォート付きの
  識別子など、書かれ方によっては数文字ずれることがあります。その場合でも**行の
  ハイライトは必ず正しい位置**に出ます。

---

## 7. static テーブル（パフォーマンス用）

ビューを `CREATE TABLE ... AS SELECT *` でテーブル化したもの（社内でいう **static 化**）です。

このビューは読むたびに `lnge_t_column_usage` と `lnge_t_impact` を結合し直し、さらに
各行で HTML 生成 UDF を呼びます。BI ツールからの利用では、**ビュー名から `vw_` を落とした
テーブル**を読むほうが速くなります。

| | 名前 | 中身 |
|---|---|---|
| ビュー | `lnge_vw_t_column_usage_impact` | 定義の正本。常に最新 |
| static テーブル | `lnge_t_column_usage_impact` | ビューを `SELECT *` でコピーした普通のテーブル。`refreshed_at` が付く |

> BigQuery の **マテリアライズドビューではありません**。このビューの定義は
> `ARRAY_AGG(... ORDER BY ...)` などを使っておりマテリアライズドビューにはできないため、
> `CREATE OR REPLACE TABLE ... AS SELECT *` で作った普通のテーブルです。

- テーブルは **03 の STEP 4b が作り直します**（impact を再構築したタイミング、
  および初回でテーブルが無いとき）。`build_static_report_tables = FALSE` で止められます。
- クラスタリングは `origin_project, origin_dataset, origin_object, origin_column`。
  **起点カラムで絞ると実際にスキャン量が落ちます**。
- ビューの定義を変えると、次の 03 実行でテーブルのスキーマも自動で追従します
  （`SELECT *` で作っているため）。

### ⚠ ハイライトの挙動だけ 1 点だけ違います

`usage_definition_html` のハイライト位置は分析関数
`ARRAY_AGG(...) OVER (PARTITION BY 起点カラム, 利用オブジェクト, 定義)` で集めています。
分析関数は `WHERE` の**後**に評価されるため、

- **ビューを読む場合**：レポート側で `depth` や `usage_type` を追加で絞ると、
  **ハイライトもその絞り込みに追従**します。
- **テーブルを読む場合**：ハイライトは作成時に確定済みで、パーティション全体で固定です。

パーティションキーに起点カラムと対象オブジェクトが入っているので、
「起点を選んでその SQL を表示する」という通常の使い方では**結果は同じ**です。
さらに絞り込んでハイライトも連動させたい場合だけ、ビューを読んでください。

### サイズに注意

`usage_definition_text` と `usage_definition_html` は、**そのオブジェクトの SQL 全文を
1 行ごとに繰り返し持ちます**（1 行 = 起点カラム × 利用箇所 × 経路）。テーブルのサイズと、
オンデマンド課金でのスキャン量がこの 2 列に支配されることがあります。SQL 表示を使わない
レポートしか無い場合は、03 の `static_tables_include_usage_sql = FALSE` でこの 2 列を
static テーブルから外せます（必要なときはビュー側から引けます）。

---

## 8. 用語

| 用語 | 意味 |
|---|---|
| **起点カラム（origin）** | 影響範囲を調べたい対象のカラム。レポートで選ぶ側 |
| **使用箇所（usage）** | そのカラム（または派生カラム）が SQL に書かれている場所 |
| **depth** | 起点から使用箇所までの距離。1 が直接参照 |
| **経路（dependency_path）** | 起点から使用箇所まで、どのオブジェクトを経由したか |
| **生成種別（generation_type）** | その SQL が View 定義か、スケジュールドクエリか、DAG か |
