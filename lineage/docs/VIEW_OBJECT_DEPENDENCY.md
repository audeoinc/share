# lnge_vw_t_object_dependency — カラム定義書

Looker Studio などでこのビューをデータソースにする方向けの資料です。
**「このテーブル／ビューを変更したら、どのテーブル／ビューが影響を受けるか」** を
カラムを意識せずに 1 テーブルで引けるように設計されたビューです。

カラム単位で「どの SQL の何行目か」まで追いたい場合は
[`VIEW_COLUMN_USAGE_IMPACT.md`](./VIEW_COLUMN_USAGE_IMPACT.md) の
`lnge_vw_t_column_usage_impact` を使ってください。本ビューはその 1 段上の
**オブジェクト（＝テーブル／ビュー）粒度**です。

> 実際のビュー名は環境ごとの prefix / suffix が付きます（既定は `lnge_vw_t_object_dependency`）。
> 定義の実体は `sql/setup/01_setup_lineage_environment.sql` にあります。

---

## 1. まずこれだけ：1 行が表すもの

**1 行 = 「起点オブジェクト」 → 「影響先オブジェクト」 の 1 ペア**

```
origin_*    … あなたが調べたいテーブル／ビュー（レポートのフィルタで指定する側）
   ↓ impact_rank 段の依存をたどって
impacted_*  … その影響が及ぶテーブル／ビュー
```

同じペアは **経路が何本あっても 1 行だけ**です。カラム単位の内訳は 1 行の中に
配列（`column_dependencies`）と文字列（`column_dependencies_text`）で畳み込まれています。

> `lnge_vw_t_column_usage_impact` が「経路ごとに行が増える」ビューだったのに対し、
> こちらは **ペアごとに 1 行**なので `COUNT(*)` がそのまま「影響先の数」になります。

### 推移的依存（transitive）です

直接の参照だけでなく、**間に何段挟まっていても**行が出ます。

| `impact_rank` | 意味 |
|---|---|
| `1` | 影響先が起点を**直接参照**している |
| `2` | 1 つ挟んで参照している（起点 → 中間 → 影響先） |
| `3` 以上 | さらに深い。数字が大きいほど遠い |

`impact_rank` は **そのペアの最短ホップ数**です。A → B → D と A → D の両方の経路がある場合、
`impact_rank = 1`、`max_impact_rank = 2` になります。

- 「直接参照だけの依存関係図を描きたい」→ `is_direct = true`（＝ `impact_rank = 1`）で絞る
- 「全下流を洗い出したい」→ 絞らない

上限は 03 パイプラインの `configured_max_impact_rank` です。これを超える深さは
そもそも記録されていません。

---

## 2. Looker Studio で使うときの注意

### 2.1 配列カラムは読めません

Looker Studio は `ARRAY` 型のフィールドを扱えません。本ビューは配列と
**同じ内容の文字列版**を必ずペアで持っています。Looker Studio では文字列版を使ってください。

| 配列（BigQuery / API 向け） | 文字列（Looker Studio 向け） |
|---|---|
| `column_dependencies` | `column_dependencies_text` |
| `shortest_object_path` | `shortest_object_path_text` |

> データソース作成時に配列カラムでエラーになる場合は、
> カスタムクエリで `SELECT * EXCEPT (column_dependencies, shortest_object_path)` としてください。

### 2.2 文字列版は改行区切りです

`column_dependencies_text` は **1 行 1 カラムペア**（`origin_column -> impacted_column (rank N)`）の
改行区切りテキストです。そのまま表に出すと 1 行に潰れて見えるため、
Community Visualization の **Templated Record** で `<pre>` に入れて表示するのが定番です
（`lnge_vw_t_column_usage_impact` の `usage_definition_html` と同じ使い方）。

`shortest_object_path_text` は ` -> ` 区切りの 1 行テキストなので、そのまま表に出せます。

---

## 3. カラム一覧

### A. 起点オブジェクト（フィルタで指定する側）

| カラム | 型 | 意味 |
|---|---|---|
| `origin_project` | STRING | 起点の GCP プロジェクト |
| `origin_dataset` | STRING | 起点のデータセット |
| `origin_object` | STRING | 起点のテーブル／ビュー名 |
| `origin_object_type` | STRING | `TABLE` / `VIEW` など（解析器が見た型） |
| `origin_generation_type` | STRING | 起点の生成種別（§4）。解析対象外なら `NULL` |
| `origin_is_analysis_target` | BOOL | 起点自身が解析対象だったか（§5） |
| `origin_full_name` | STRING | `project.dataset.object`。**フィルタやディメンションはこれ 1 本で足ります** |

### B. 影響先オブジェクト

| カラム | 型 | 意味 |
|---|---|---|
| `impacted_project` | STRING | 影響先の GCP プロジェクト |
| `impacted_dataset` | STRING | 影響先のデータセット |
| `impacted_object` | STRING | 影響先のテーブル／ビュー名 |
| `impacted_object_type` | STRING | `TABLE` / `VIEW` など |
| `impacted_generation_type` | STRING | 影響先の生成種別（§4） |
| `impacted_is_analysis_target` | BOOL | 影響先が解析対象だったか。通常は `true` |
| `impacted_full_name` | STRING | `project.dataset.object` |

### C. 距離と規模

| カラム | 型 | 意味 |
|---|---|---|
| `impact_rank` | INT64 | **最短ホップ数**。`1` = 直接参照 |
| `max_impact_rank` | INT64 | 最長ホップ数。`impact_rank` と差があれば複数の深さの経路がある |
| `is_direct` | BOOL | `impact_rank = 1` のショートカット |
| `path_count` | INT64 | このペアを結ぶ**経路の総数**（カラムペアごとの経路数の合計） |
| `column_pair_count` | INT64 | 依存しているカラムの組み合わせ数（`column_dependencies` の要素数） |
| `origin_column_count` | INT64 | 影響元として関わっている起点カラムの種類数 |
| `impacted_column_count` | INT64 | 影響を受ける影響先カラムの種類数 |

**「影響が大きい順」に並べたい**とき：`column_pair_count` か `impacted_column_count` で降順ソート。
`path_count` は経路の多さ（＝依存の絡み合い具合）であって影響の大きさではないので注意。

### D. カラム内訳

| カラム | 型 | 意味 |
|---|---|---|
| `column_dependencies` | ARRAY&lt;STRUCT&gt; | カラムペアの明細。要素は下表 |
| `column_dependencies_text` | STRING | 同じ内容の改行区切りテキスト（Looker Studio 用） |
| `origin_columns_text` | STRING | 関わっている起点カラム名のカンマ区切り一覧 |
| `impacted_columns_text` | STRING | 影響を受ける影響先カラム名のカンマ区切り一覧 |

`column_dependencies` の要素：

| フィールド | 型 | 意味 |
|---|---|---|
| `origin_column` | STRING | 起点側のカラム名。`SELECT *` 由来など特定できない場合は `*` |
| `impacted_column` | STRING | 影響先側のカラム名。同上 |
| `impact_rank` | INT64 | **このカラムペアの**最短ホップ数 |
| `path_count` | INT64 | このカラムペアを結ぶ経路数 |
| `resolution_statuses` | STRING | このカラムペアに現れた解決状態のカンマ区切り（§6） |

### E. 経路と品質

| カラム | 型 | 意味 |
|---|---|---|
| `shortest_object_path` | ARRAY&lt;STRING&gt; | 最短経路のオブジェクト列。`project.dataset.object` が起点から順に並ぶ |
| `shortest_object_path_text` | STRING | 同じ内容を ` -> ` で連結した 1 行テキスト（Looker Studio 用） |
| `has_cycle_path` | BOOL | 経路のどこかで循環参照を検出した（§7） |
| `is_fully_resolved` | BOOL | すべてのカラムペアが完全解決（`RESOLVED`）だった（§6） |
| `snapshot_at` | TIMESTAMP | この依存関係が計算された時刻（＝直近の 03 実行時刻） |

`shortest_object_path` は**カラム経路からオブジェクト部分だけを取り出し、連続する重複を畳んだもの**です。
同じオブジェクトの複数カラムを経由しても 1 ホップとして数えます。

---

## 4. `generation_type`（オブジェクトの作られ方）

| 値 | 意味 |
|---|---|
| `VIEW` | `INFORMATION_SCHEMA.VIEWS` から取得した VIEW 定義 |
| `JOB_DDL` | `CREATE TABLE ... AS SELECT` などの DDL ジョブで作られたテーブル |
| `JOB_QUERY` | クエリジョブの出力先として作られたテーブル（DAG の INSERT / 洗い替えなど） |

`NULL` になるのは「参照されているだけで解析対象ではない」オブジェクト（＝生のソーステーブル）です。

---

## 5. このビューに出てくる範囲（重要）

03 パイプラインの `DECLARE` で **解析対象に指定した範囲**だけが出ます。具体的には、
起点・影響先の**両方**について次が除外されています。

| 除外されるもの | 理由 |
|---|---|
| **EPHEMERAL オブジェクト** | 一時テーブルや名前が毎回変わる出力先を SQL 指紋でまとめた合成 ID（`fp_<hash>`）。実体が無いので依存関係図に出しても意味がない |
| **非アクティブなオブジェクト** | 既に削除されたテーブル／ビュー |
| **解析が成功していないオブジェクト** | `analysis_status` が `COMPLETED` / `COMPLETED_WITH_WARNINGS` 以外。依存関係が不完全なため |

### 除外されたオブジェクトを「経由する」依存は残ります

たとえば `A → (一時テーブル) → B` の場合、一時テーブルの行は消えますが
**`A → B`（`impact_rank = 2`）の行はそのまま出ます**。
元データが「起点 → 影響先」ペアごとに経路を保持しているため、端点を除外しても
到達関係そのものは失われません。

### 解析対象外の上流（生のソーステーブル）は残ります

参照されているだけで解析対象ではないテーブル（GA4 の raw テーブルなど）は
`origin_is_analysis_target = false` として**残しています**。これを消すと
「外部から解析対象領域に入ってくる依存」がすべて消えてしまうためです。

- 「解析対象どうしの依存だけ見たい」→ `origin_is_analysis_target = true` で絞る
- 「どの生ソースがどこに効いているか見たい」→ 絞らない

---

## 6. `resolution_statuses` / `is_fully_resolved`

依存 1 本ごとの「解析の確からしさ」です。

| 値 | 意味 |
|---|---|
| `RESOLVED` | 物理カラムまで完全に特定できた |
| `SOURCE_RESOLVED` | ソースのオブジェクトは特定できたが、カラムまでは絞り切れていない |
| `PARTIALLY_RESOLVED` | 一部だけ特定できた（式の一部が解釈できないなど） |

`is_fully_resolved = false` の行は「依存はあるが、カラム対応の一部が推定」という意味です。
**依存関係の有無としては信頼してよく**、カラム単位で厳密に議論するときだけ注意してください。

---

## 7. `has_cycle_path`（循環参照）

経路をたどる途中で**同じカラムに戻ってきた**ことを示します。自分自身を参照して洗い替える
テーブルなどで立ちます。循環を検出した時点で経路の伸長は打ち切られるので、
`has_cycle_path = true` の行の `max_impact_rank` は「そこで打ち切られた深さ」です。

---

## 8. よくある使い方

| やりたいこと | 指定 |
|---|---|
| あるテーブルの**下流**を全部出す | `origin_full_name` = 対象 |
| あるビューの**上流**を全部出す | `impacted_full_name` = 対象 |
| 直接依存だけの関係図 | 上記に加えて `is_direct = true` |
| 影響の大きい下流から見る | `column_pair_count` 降順 |
| 経路を確認する | `shortest_object_path_text` を表示 |
| どのカラム経由か確認する | `column_dependencies_text` を `<pre>` で表示 |
| 解析対象どうしに限定 | `origin_is_analysis_target = true` |

### データの鮮度

`lnge_t_impact` は 03 パイプラインの STEP 4 が**毎回全置換**するため、このビューは常に
最新スナップショットです。日付での絞り込みは不要で、`snapshot_at` は
「いつ時点のデータか」を表示するためだけに使ってください。

---

## 9. 用語

| 用語 | 意味 |
|---|---|
| **オブジェクト** | テーブルまたはビュー。本ビューの粒度 |
| **起点（origin）** | 変更する側。依存の上流 |
| **影響先（impacted）** | 影響を受ける側。依存の下流 |
| **ホップ（rank）** | 起点から影響先までに挟まるオブジェクトの段数。直接参照が 1 |
| **経路（path）** | 起点から影響先に至る 1 本のたどり方。同じペアでも複数ありうる |
| **EPHEMERAL** | 一時／名前が毎回変わる出力先を指紋でまとめた合成オブジェクト |
