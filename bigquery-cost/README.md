# BigQuery 費用チェック用 SQL 集

BigQuery の利用費用を「いくら／どのクエリ／誰が／どのテーブル」で確認するためのクエリ集です。
プロジェクト `audeodb` を想定していますが、テーブル参照を書き換えれば他プロジェクトでも使えます。

> **前提メモ**: このリポジトリの `agent/proposal-sample`（顧客提案ジェネレーター）は
> `proposal_app/store.py` がインメモリ実装で、**実際には BigQuery を呼んでいません**。
> したがって proposal-app 由来の BQ 費用はゼロで、実際に発生しているのは Vertex AI（Gemini）と Cloud Run です。
> ここの SQL は「`store.py` を本物の BQ に差し替えたとき」および「audeodb の BQ 費用一般」の確認用です。
> まず `06_billing_export_all_services.sql` でサービス別の内訳を見ると切り分けが早いです。

## ファイル一覧

| ファイル | 何が分かるか | データ源 |
|---|---|---|
| `01_query_cost_by_job.sql` | ジョブ単位のクエリ費用（高い順）＝**犯人特定** | INFORMATION_SCHEMA |
| `02_daily_query_cost.sql` | 日次の課金バイト／推定費用の推移＝**いつ跳ねたか** | INFORMATION_SCHEMA |
| `03_cost_by_user.sql` | 実行者（人／サービスアカウント）別の集計 | INFORMATION_SCHEMA |
| `04_storage_by_table.sql` | テーブル別のストレージ費用（アクティブ／長期） | INFORMATION_SCHEMA |
| `05_billing_export_bigquery.sql` | BigQuery の**実額**を SKU 内訳で | 請求データエクスポート |
| `06_billing_export_all_services.sql` | サービス別の実額（Vertex AI / Cloud Run 含む） | 請求データエクスポート |
| `07_dry_run.sh` | 実行**前**にスキャン量を確認する（課金なし） | bq CLI |

## 実行前に書き換えるところ

### INFORMATION_SCHEMA 系（01〜04）

```sql
FROM `audeodb.region-asia-northeast1`.INFORMATION_SCHEMA.JOBS_BY_PROJECT
        ^^^^^^^ ^^^^^^^^^^^^^^^^^^^^^^
        プロジェクト  データセットのリージョン
```

- **リージョンがズレていると 0 件で返ります**（エラーにならないので気づきにくい）。
  US なら `region-us`、東京なら `region-asia-northeast1`。
- 単価 `usd_per_tib` はスクリプト冒頭の `DECLARE` にあります。既定値は
  US マルチリージョンのオンデマンド参考値（$6.25/TiB）なので、
  [料金ページ](https://cloud.google.com/bigquery/pricing) で自分のリージョンの値に合わせてください。

### 請求エクスポート系（05〜06）

```sql
FROM `audeodb.billing.gcp_billing_export_v1_XXXXXX_XXXXXX_XXXXXX`
```

Cloud Console → お支払い → **課金データのエクスポート** で BigQuery 出力を有効化し、
できたテーブル名に置き換えます。**有効化した時点以降のデータしか入らない**ため、過去には遡れません。

## 実行方法

```bash
# ローカルPC（gcloud 認証済み）で
bq query --project_id=audeodb --use_legacy_sql=false < 02_daily_query_cost.sql

# 実行前のスキャン量チェック（課金なし）
./07_dry_run.sh audeodb 01_query_cost_by_job.sql
```

Cloud Console の BigQuery エディタに貼り付けてもそのまま動きます（`DECLARE` 込みのマルチステートメント）。

## 推定と実額の使い分け

- **01〜04 は推定**です。`total_bytes_billed` × 単価で計算しているだけなので、
  割引・コミット・無料枠は反映されません。**「どれが高いか」の相対比較に使う**のが正しい使い方。
- **実額を知りたいなら 05／06、または Cloud Console のお支払い → レポート**（サービス = BigQuery、
  グループ化 = SKU）を見ます。こちらが割引・クレジット適用後の真の金額です。

## ハマりどころ

- `INFORMATION_SCHEMA.JOBS_BY_PROJECT` の履歴保持は **180 日**。それ以前は追えません。
- **キャッシュヒット**したクエリは `total_bytes_billed = 0`（無料）。`cache_hit` 列で確認できます。
- 1 テーブルあたり**最低 10MB** が課金対象になるため、極小クエリでも 0 にはなりません。
- **定額（Editions / スロット）契約**の場合、`total_bytes_billed` は課金と無関係になり 01〜03 の推定は無意味です。
- 無料枠は **クエリ 1 TiB/月・ストレージ 10 GiB/月**。学習用途ならたいてい枠内に収まります。

## 費用を「確認」より先にやるべきこと

1. **予算アラート**: お支払い → 予算とアラート で月次予算＋50/90/100% 通知。
2. **上限バイトで強制失敗**: `bq query --maximum_bytes_billed=1000000000 ...`
   （Python SDK なら `QueryJobConfig(maximum_bytes_billed=...)`）。想定外の全スキャンをジョブごと落とせます。
3. **カスタム割り当て**: IAM と管理 → 割り当て →「Query usage per day」でプロジェクト日次上限。
4. `SELECT *` を避け、パーティション列で必ず絞る。BQ はスキャンした列 × 行に課金されるので、これが一番効きます。
