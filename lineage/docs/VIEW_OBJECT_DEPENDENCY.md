# lnge_t_object_dependency — カラム定義書

Looker Studio でこのテーブルをデータソースにしてレポートを作る方向けの資料です。

**「このテーブル／ビューを変更したら、どのテーブル／ビューが影響を受けるか」** を
カラムを意識せずに 1 テーブルで引けるように作ってあります。

カラム単位で「どの SQL の何行目か」まで追いたい場合は
[`VIEW_COLUMN_USAGE_IMPACT.md`](./VIEW_COLUMN_USAGE_IMPACT.md) の
`lnge_t_column_usage_impact` を使ってください。本テーブルはその 1 段上の
**オブジェクト（＝テーブル／ビュー）粒度**です。

## 0. どちらを参照するか

| | 名前 | 使う場面 |
|---|---|---|
| **static テーブル** | `lnge_t_object_dependency` | **レポートはこちら**。ビューを `CREATE TABLE ... AS SELECT *` でテーブル化したもの（社内でいう static 化）。クラスタリングが効くので速い |
| ビュー | `lnge_vw_t_object_dependency` | 定義の正本。アドホックに最新を見たいとき |

- 中身は同じで、static テーブルには `updated_at`（テーブルを作り直した時刻）が 1 列増えます。
- static テーブルは日次パイプライン `03` が作り直します。
- BigQuery の**マテリアライズドビューではありません**。ビューの定義が
  `ARRAY_AGG(... ORDER BY ...)` などを使っておりマテビューにできないため、普通のテーブルです。

> 実際の名前には環境ごとの prefix / suffix が付きます（既定は上記のとおり）。
> 定義の実体はビューが `sql/setup/01_setup_lineage_environment.sql`、
> static テーブル化が `sql/pipeline/03_run_daily_lineage_pipeline.sql` の STEP 4b にあります。

カラムは全 31 列（ビューの 30 列 + `updated_at`）です。多いですが、
**実際にレポートで使うのは §2 の「よく使う 8 列」だけで足ります**。残りは
「もっと詳しく知りたくなったとき」用の補助情報です。

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

> `lnge_t_column_usage_impact` が「経路ごとに行が増える」ので `COUNT(*)` に注意が必要だったのに対し、
> こちらは **ペアごとに 1 行**です。起点を 1 つに絞れば `COUNT(*)` がそのまま「影響先の数」になります。
> （起点を絞らない場合の `COUNT(*)` は「ペアの数」であって「オブジェクトの数」ではありません）

### 推移的依存（transitive）です

直接の参照だけでなく、**間に何段挟まっていても**行が出ます。

| `impact_rank` | 意味 |
|---|---|
| `1` | 影響先が起点を**直接参照**している |
| `2` | 1 つ挟んで参照している（起点 → 中間 → 影響先） |
| `3` 以上 | さらに深い。数字が大きいほど遠い |

上限は 03 の `configured_max_impact_rank` です。これを超える深さは記録されていません。

### rank は「起点からの距離」です（影響先の属性ではありません）

`impact_rank` は **選んだ起点からの相対値**で、**同じ影響先でも起点が変われば変わります**。

```
A → B → C のとき
  起点 A の行 … B は rank 1、C は rank 2
  起点 B の行 … C は rank 1
```

グラフ上のすべてのオブジェクトが起点になり得るので、中間のビューを起点に指定すれば
そこから下だけの依存関係が rank 1 から数え直されて出ます。
**必ず起点を 1 つ指定してから rank を読んでください**（起点を絞らずに rank で集計すると、
別々の起点の距離が混ざります）。

---

## 2. よく使う 8 列（まずこれだけ覚える）

| カラム | 使いどころ |
|---|---|
| `origin_full_name` | **起点のフィルタ／コントロール**。`project.dataset.object` の 1 本 |
| `impacted_full_name` | **影響先のフィルタ／コントロール**、および一覧表の主キー列 |
| `impact_rank` | 距離。並び順にも、直接／間接の切り分けにも使う |
| `is_direct` | 「直接参照だけ」に絞るチェックボックス用 |
| `impacted_object_type` | TABLE / VIEW の色分け |
| `impacted_generation_type` | View か DAG 生成テーブルか（対応の当て先が変わる） |
| `column_pair_count` | **影響の大きさの目安**。降順ソートに使う |
| `column_dependencies_text` | どのカラム経由かの明細（`<pre>` で表示） |

---

## 3. レポートの型は 3 つ（先に決める）

### ① 下流を見る（変更影響調査）— いちばん多い使い方

`origin_full_name` をコントロールで 1 つ選ばせ、`impacted_*` を一覧にする。

> 「このテーブルを直すと、どこが壊れるか」

### ② 上流を見る（データの出どころ調査）

`impacted_full_name` を 1 つ選ばせ、`origin_*` を一覧にする。
グラフ上の全ノードが起点になっているので、**同じテーブルで逆向きも引けます**。

> 「このダッシュボード用ビューは、何から作られているか」

### ③ 全体マップ（絞らない）

`is_direct = true` に絞って、`origin_full_name` → `impacted_full_name` の
直接依存だけを一覧／散布図にする。**絞らないと推移的な行まで全部出てくるので必ず `is_direct` を使ってください。**

---

## 4. カラム一覧

### A. 起点オブジェクト（＝変更する側 / 依存の上流）

| カラム | 型 | 意味 | 使いどころ |
|---|---|---|---|
| `origin_project` | STRING | 起点の GCP プロジェクト | プロジェクトが複数ある環境での絞り込み |
| `origin_dataset` | STRING | 起点のデータセット | 段階コントロールの 2 段目 |
| `origin_object` | STRING | 起点のテーブル／ビュー名 | 段階コントロールの 3 段目 |
| `origin_object_type` | STRING | `TABLE` / `VIEW` など | 起点の種類で絞りたいとき |
| `origin_generation_type` | STRING | 起点の生成種別（§6）。解析対象外なら `NULL` | 起点が View か生成テーブルかの判別 |
| `origin_is_analysis_target` | BOOL | 起点自身が解析対象だったか（§7） | `true` に絞ると「解析対象どうしの依存」だけになる |
| `origin_full_name` | STRING | `project.dataset.object` | **通常はこれ 1 本でフィルタ／ディメンションに使う** |

> 3 分割の列は「データセット単位で集計したい」「プロジェクト横断で見たい」ときに使います。
> 単に 1 つのオブジェクトを選ばせたいだけなら `origin_full_name` だけで十分です。

### B. 影響先オブジェクト（＝影響を受ける側 / 依存の下流）

| カラム | 型 | 意味 | 使いどころ |
|---|---|---|---|
| `impacted_project` | STRING | 影響先のプロジェクト | 〃 |
| `impacted_dataset` | STRING | 影響先のデータセット | **「どのデータセットに影響が集中しているか」の集計軸** |
| `impacted_object` | STRING | 影響先のテーブル／ビュー名 | 一覧表の表示名 |
| `impacted_object_type` | STRING | `TABLE` / `VIEW` など | アイコン／色分け |
| `impacted_generation_type` | STRING | 影響先の生成種別（§6） | **対応の当て先が変わる**（View 定義を直す／DAG を直す） |
| `impacted_is_analysis_target` | BOOL | 影響先が解析対象だったか | 通常は常に `true`。基本は無視してよい |
| `impacted_full_name` | STRING | `project.dataset.object` | **一覧表の主キー列。個別カウントの対象** |

### C. 距離と規模

| カラム | 型 | 意味 | 使いどころ |
|---|---|---|---|
| `impact_rank` | INT64 | **最短ホップ数**。`1` = 直接参照 | 並び順（昇順＝近い順）。対応の優先度づけ |
| `max_impact_rank` | INT64 | カラムペアごとの最短距離のうち**最も遠いもの** | `impact_rank` と差があれば「近い経路と遠い経路が混在」の合図 |
| `is_direct` | BOOL | `impact_rank = 1` のショートカット | 直接依存だけの関係図 |
| `path_count` | INT64 | このペアを結ぶ**経路の総数**（カラムペアごとの経路数の合計） | 依存の絡み合い具合。**影響の大きさではない** |
| `column_pair_count` | INT64 | 依存しているカラムの組み合わせ数（`column_dependencies` の要素数） | **影響の大きさの第一候補。降順ソート** |
| `origin_column_count` | INT64 | 影響元として関わっている起点カラムの種類数 | 「起点のどれだけのカラムが使われているか」 |
| `impacted_column_count` | INT64 | 影響を受ける影響先カラムの種類数 | **「向こう側で何列直すことになるか」** |

**指標の選び方**

- 「対応工数の大きい順」に並べたい → `impacted_column_count` 降順
- 「依存の濃い順」に並べたい → `column_pair_count` 降順
- `path_count` は経路の本数です。同じ 1 カラムでも到達ルートが 3 本あれば 3 になるので、
  **影響の大きさの指標としては使わないでください**（グラフの複雑さの指標です）。

### D. カラム内訳

| カラム | 型 | 意味 | 使いどころ |
|---|---|---|---|
| `column_dependencies` | ARRAY&lt;STRUCT&gt; | カラムペアの明細（要素は下表） | **Looker Studio では読めません**。SQL / API 用 |
| `column_dependencies_text` | STRING | 同じ内容の改行区切りテキスト | **明細ページで `<pre>` 表示**。1 行 = 1 カラムペア |
| `origin_columns_text` | STRING | 関わっている起点カラム名のカンマ区切り | 一覧表に 1 列だけ足したいとき（短い） |
| `impacted_columns_text` | STRING | 影響を受ける影響先カラム名のカンマ区切り | 〃。**「向こう側で直す列」がひと目で分かる** |

`column_dependencies` の要素（＝ `column_dependencies_text` の 1 行に対応）：

| フィールド | 型 | 意味 |
|---|---|---|
| `origin_column` | STRING | 起点側のカラム名。`SELECT *` 由来など特定できない場合は `*` |
| `impacted_column` | STRING | 影響先側のカラム名。同上 |
| `impact_rank` | INT64 | **このカラムペアの**最短ホップ数 |
| `path_count` | INT64 | このカラムペアを結ぶ経路数 |
| `resolution_statuses` | STRING | このカラムペアに現れた解決状態のカンマ区切り（§8） |

`column_dependencies_text` の 1 行はこの形式です：

```
order_id -> order_id (rank 1)
amount   -> total_amount (rank 2)
```

### E. 経路と品質

| カラム | 型 | 意味 | 使いどころ |
|---|---|---|---|
| `shortest_object_path` | ARRAY&lt;STRING&gt; | 最短経路のオブジェクト列。`project.dataset.object` が起点から順に並ぶ | **Looker Studio では読めません**。SQL / API 用 |
| `shortest_object_path_text` | STRING | 同じ内容を ` -> ` で連結した 1 行テキスト | **一覧表にそのまま出せます**。「何を経由しているか」の確認用 |
| `has_cycle_path` | BOOL | 経路のどこかで循環参照を検出した（§9） | `true` の行に注意アイコンを出す |
| `is_fully_resolved` | BOOL | すべてのカラムペアが完全解決（`RESOLVED`）だった（§8） | `false` は「依存はあるがカラム対応の一部が推定」 |

`shortest_object_path` は**カラム経路からオブジェクト部分だけを取り出し、連続する重複を畳んだもの**です。
同じオブジェクトの複数カラムを経由しても 1 ホップとして数えます。要素数は `impact_rank + 1`
（起点と影響先を含むため）になります。

### F. 時刻

| カラム | 型 | 意味 | 使いどころ |
|---|---|---|---|
| `snapshot_at` | TIMESTAMP | **依存関係が計算された時刻**（影響グラフの再構築時刻） | データの中身がいつ時点か |
| `updated_at` | TIMESTAMP | **static テーブルを作り直した時刻**（static テーブルのみ） | レポートのフッターに「最終更新」として出す |

両方とも同じ 03 の実行に由来し、`snapshot_at` のほうが少し早い時刻になります。
**レポートに出すなら `updated_at` で十分**です。
どちらも**日付での絞り込みには使いません**（履歴を持たないため、常に最新の 1 スナップショットだけです）。

---

## 5. Looker Studio でのデータソース設定

### 5.1 配列カラムは読めません

Looker Studio は `ARRAY` 型のフィールドを扱えません。本テーブルには配列が 2 列
（`column_dependencies`、`shortest_object_path`）ありますが、**同じ内容の文字列版が必ず
併設されています**ので、そちらを使ってください。

| 配列（SQL / API 用） | 文字列（Looker Studio 用） |
|---|---|
| `column_dependencies` | `column_dependencies_text` |
| `shortest_object_path` | `shortest_object_path_text` |

データソース作成時に配列カラムでエラーになる場合は、**カスタムクエリ**にして次のようにしてください。

```sql
SELECT * EXCEPT (column_dependencies, shortest_object_path)
FROM `<project>.<dataset>.lnge_t_object_dependency`
```

### 5.2 改行区切りのテキストの見せ方

`column_dependencies_text` は **1 行 1 カラムペア**の改行区切りテキストです。
通常の表に出すと 1 行に潰れて見えるので、Community Visualization の
**Templated Record** で `<pre>` に入れて表示するのが定番です
（`lnge_t_column_usage_impact` の `usage_definition_html` と同じ使い方）。

`shortest_object_path_text` は ` -> ` 区切りの 1 行テキストなので、そのまま表に出せます。

### 5.3 あると便利な計算フィールド

```
直接／間接         : IF(is_direct, "直接", "間接")
距離バケット       : CASE WHEN impact_rank = 1 THEN "1 直接"
                         WHEN impact_rank = 2 THEN "2 一段下"
                         ELSE "3+ 深い" END
影響先データセット : CONCAT(impacted_project, ".", impacted_dataset)
```

---

## 6. レポートの作り方（推奨パターン）

### パターン 1：影響サマリー（まず全体像）

- コントロール：`origin_full_name`（必須）
- スコアカード：`impacted_full_name` の**個別カウント** … 影響を受けるオブジェクト数
- 円／棒グラフ：ディメンション `impact_rank`、指標 同上
  → 「直接 3 件、2 段下流 12 件」のような把握ができます
- 棒グラフ：ディメンション `impacted_dataset` → 影響がどこに集中しているか

### パターン 2：影響オブジェクト一覧（対応の起点）

- コントロール：`origin_full_name`（必須）
- 表のディメンション：`impacted_full_name`、`impacted_object_type`、
  `impacted_generation_type`、`impact_rank`
- 指標：`impacted_column_count`、`column_pair_count`
- 並び順：`impact_rank` 昇順 → 近いものから対応できます
- 条件付き書式：`has_cycle_path = true` の行に色を付けると親切です

### パターン 3：経路の確認（なぜ影響するのか）

- パターン 2 の表から遷移する明細ページ
- `shortest_object_path_text` を 1 列で表示 → 「何を経由して届いているか」
- `impacted_columns_text` を並べて表示 → 「向こう側で直す列」

### パターン 4：カラム内訳のドリルダウン

- Templated Record で `column_dependencies_text` を `<pre>` 表示
- 併せて `is_fully_resolved` を出し、`false` のときは
  「カラム対応の一部が推定です」と注意書きが出るようにすると親切です
- さらに細かく「どの SQL の何行目か」まで要る場合は、
  `lnge_t_column_usage_impact` のレポートへリンクしてください

### パターン 5：上流の確認（データの出どころ）

- コントロール：`impacted_full_name`（必須）
- 表のディメンション：`origin_full_name`、`origin_generation_type`、`impact_rank`
- 並び順：`impact_rank` 昇順 → 直近の入力元から並びます

---

## 7. `generation_type`（オブジェクトの作られ方）

| 値 | 意味 | 対応するときの当て先 |
|---|---|---|
| `VIEW` | `INFORMATION_SCHEMA.VIEWS` から取得した VIEW 定義 | VIEW の DDL |
| `JOB_DDL` | `CREATE TABLE ... AS SELECT` などの DDL ジョブで作られたテーブル | そのジョブを流している SQL / DAG |
| `JOB_QUERY` | クエリジョブの出力先として作られたテーブル（DAG の INSERT / 洗い替えなど） | 〃 |

`NULL` になるのは「参照されているだけで解析対象ではない」オブジェクト（＝生のソーステーブル）です。

---

## 8. このテーブルに出てくる範囲（重要）

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

## 9. `resolution_statuses` / `is_fully_resolved`

依存 1 本ごとの「解析の確からしさ」です。

| 値 | 意味 |
|---|---|
| `RESOLVED` | 物理カラムまで完全に特定できた |
| `SOURCE_RESOLVED` | ソースのオブジェクトは特定できたが、カラムまでは絞り切れていない |
| `PARTIALLY_RESOLVED` | 一部だけ特定できた（式の一部が解釈できないなど） |

`is_fully_resolved = false` の行は「依存はあるが、カラム対応の一部が推定」という意味です。
**依存関係の有無としては信頼してよく**、カラム単位で厳密に議論するときだけ注意してください。
レポートでこの行を除外する必要はありません。

---

## 10. `has_cycle_path`（循環参照）

経路をたどる途中で**同じカラムに戻ってきた**ことを示します。自分自身を参照して洗い替える
テーブルなどで立ちます。循環を検出した時点で経路の伸長は打ち切られるので、
`has_cycle_path = true` の行の `max_impact_rank` は「そこで打ち切られた深さ」です。

件数としては少ないはずなので、**一覧表で色を付けて気付けるようにしておく**程度で十分です。

---

## 11. データの鮮度

| 項目 | 内容 |
|---|---|
| **更新タイミング** | 日次パイプライン（`03_run_daily_lineage_pipeline.sql`）の実行時 |
| **更新されない日** | 解析対象に変更が無かった日は作り直されません（`updated_at` が前日のままになります） |
| **スナップショット** | 影響グラフは毎回**全件置き換え**。履歴は持ちません |
| **対象範囲** | §8 のとおり、パイプラインの設定で解析対象に含まれるオブジェクトのみ |

日付でのフィルタは不要です。`updated_at` は「最終更新」の表示だけに使ってください。

---

## 12. よくある使い方（早見表）

| やりたいこと | 指定 |
|---|---|
| あるテーブルの**下流**を全部出す | `origin_full_name` = 対象 |
| あるビューの**上流**を全部出す | `impacted_full_name` = 対象 |
| 直接依存だけの関係図 | `is_direct = true` |
| 影響の大きい下流から見る | `impacted_column_count` 降順 |
| 経路を確認する | `shortest_object_path_text` を表示 |
| どのカラム経由か確認する | `column_dependencies_text` を `<pre>` で表示 |
| 解析対象どうしに限定 | `origin_is_analysis_target = true` |
| 影響がどこに集中しているか | ディメンション `impacted_dataset`、指標 `impacted_full_name` の個別カウント |

---

## 13. 用語

| 用語 | 意味 |
|---|---|
| **オブジェクト** | テーブルまたはビュー。本テーブルの粒度 |
| **起点（origin）** | 変更する側。依存の上流 |
| **影響先（impacted）** | 影響を受ける側。依存の下流 |
| **ホップ（rank）** | 起点から影響先までに挟まるオブジェクトの段数。直接参照が 1 |
| **経路（path）** | 起点から影響先に至る 1 本のたどり方。同じペアでも複数ありうる |
| **推移的依存** | 直接参照だけでなく、間に何段挟まっていてもたどる依存 |
| **EPHEMERAL** | 一時／名前が毎回変わる出力先を指紋でまとめた合成オブジェクト |
| **static 化** | ビューを `CREATE TABLE ... AS SELECT *` でテーブルにすること |
