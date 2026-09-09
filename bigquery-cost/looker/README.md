# Looker Studio レポートの作り方

`pipeline/01〜03` を流したあとの手順です。**データソースは静的テーブル
`bqc_t_daily_cost_report` の 1 本だけ**にしてください。日次集約と fingerprint 次元は
この中で結合済みなので、Looker Studio 側でブレンドを組む必要はありません。

同名のビュー `bqc_vw_t_daily_cost_report` もありますが、そちらは**定義の正本**です。
ビューを直接データソースにすると開くたびに集約と JOIN が走り、フィルタが計算列に
当たるためクラスタプルーニングも効きません。`03` が毎回ビューをテーブルへ焼き直すので、
**接続先はテーブルのほう**にしてください（列を足したいときはビューを直せば、
次回の `03` でテーブルにも反映されます）。

`INFORMATION_SCHEMA.JOBS` を直接データソースにするのは避けてください。メタデータ
クエリはキャッシュされず、参照テーブルあたり最低 10MB が課金対象になるため、
レポートを開くたびに費用が発生します。加えて JOBS の履歴は 180 日で消えます。

## 1. 接続

1. Looker Studio → データソースを作成 → BigQuery
2. プロジェクト `audeodb` → データセット `bq_cost_repository`
   → **テーブル `bqc_t_daily_cost_report`**
3. 接続後、フィールドの型を確認する
   - `usage_date` / `usage_month` / `first_seen_date` / `last_seen_date` … 日付
   - `is_first_seen_date` … 真偽値
   - `tib_billed` / `slot_hours` … 数値（集計は合計）
   - `snapshot_at` … 日時。このテーブルを最後に焼いた時刻なので、
     スコアカードに最大値を置くとダッシュボードの鮮度表示になる

## 2. 計算フィールド

金額はテーブルに格納していません。単価がリージョンとエディションで変わるため、
格納すると単価改定のたびに過去データが実態と食い違うからです。Looker Studio 側の
計算フィールドで持たせてください。

| フィールド名 | 式 | 備考 |
|---|---|---|
| `推定コスト(USD)` | `tib_billed * 6.25` | オンデマンド単価。**自分のリージョンの値に直すこと**（6.25 は US マルチリージョンの参考値） |
| `キャッシュ率` | `cache_hit_count / job_count` | 削減余地の指標 |
| `1実行あたりTiB` | `tib_billed / job_count` | 「重いのか、回数が多いのか」の切り分け |

`推定コスト(USD)` は `pricing_model = ON_DEMAND` の行にだけ意味があります。
`CAPACITY`（予約）の行では課金の基礎はスロットなので、`slot_hours` を見てください。
**両方を1つのスコアカードで合計しないこと。** ページかグラフを分けます。

## 3. ページ構成

### ページ1: Overview

- 期間フィルタ: `usage_date`（既定は過去30日）
- コントロール: `pricing_model`, `job_region`, `executor_id`
- スコアカード: `推定コスト(USD)` 合計 / `slot_hours` 合計 / `job_count` 合計 / `キャッシュ率`
- 時系列: `usage_date` × `tib_billed`、内訳を `pricing_model` で分割
- 円/棒: `executor_id` 別の `tib_billed` 上位10件

### ページ2: 月単位で同じ SQL のコストを見る

ピボットテーブル 1 枚で足ります。

- 行ディメンション: `normalized_fingerprint`、`normalized_preview`
- 列ディメンション: `usage_month`
- 指標: `推定コスト(USD)` または `slot_hours`
- 並べ替え: 指標の降順

`normalized_preview`（正規化SQLの先頭100文字）だけだと `SELECT` の列リストで
終わってしまうことが多いので、識別しづらいときは `normalized_from_preview`
（最初の `FROM` 以降100文字）を列に足してください。参照テーブルそのものを見たい場合は
`referenced_tables_text` を使います。

> 表示しているのは常に**リテラルを `?` に置換した SQL** です。原文は Looker Studio
> からは参照できません（PII 混入リスクの回避）。原文が必要な場合は
> `bqc_t_job_cost.query` を BigQuery 側で `normalized_fingerprint` を条件に引きます。

### ページ3: 新しくコストを発生させた SQL

- フィルタ: `is_first_seen_date` = `true`
- 表: `usage_date` / `normalized_preview` / `executor_id` / `推定コスト(USD)` / `job_count`
- 並べ替え: `推定コスト(USD)` 降順

`is_first_seen_date` は「その日にこの fingerprint が初めて観測された」という意味です。
判定基準の `first_seen_date` は `bqc_m_query_fingerprint` が持っています。

> **「新規」は保持期間の中での新規です。** データの対象は
> `INFORMATION_SCHEMA.JOBS` が持っている範囲（最大 180 日）だけなので、それ以前に
> 動いていた SQL でも、保持期間内で初めて現れれば新規として出ます。
>
> **とくに初回は全件が新規に見えます。** バックフィル初日に観測された SQL は
> 一律その日が `first_seen_date` になるためです。運用開始から数日は、
> このページを「新規」ではなく「棚卸し」として見てください。

### ページ4: 実行者とラベルのカバレッジ

- 表: `executor_id` / `executor_source` / `tib_billed` / `slot_hours` / `job_count`
- スコアカード: `executor_source = LABEL` の `job_count` ÷ 全体
  → **ジョブラベル `subsystemid` の付与カバレッジ**そのものです。
  ラベル付けを広げていく運用なら、この数字自体が進捗指標になります。

## 4. 更新のタイミング

`pipeline/02` → `03` の順にスケジュールドクエリで日次実行してください。
`bqc_t_daily_cost_report` は `03` の実行ごとに全置換されます。

Looker Studio のデータ更新頻度は 12 時間程度で十分です（元データが日次のため、
それより短くしても新しい数字は出てきません）。実際にいつのデータを見ているかは
`snapshot_at` で確認できます。
