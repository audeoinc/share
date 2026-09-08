-- 01: ジョブ単位のクエリ費用（高い順）＝「どのクエリが高いか」を特定する
--
-- 使い方:
--   1) 下の PROJECT / REGION を自分の環境に合わせて書き換える
--      - REGION は「データセットのリージョン」。ズレていると 0 件で返るので注意
--        例: region-asia-northeast1 / region-us / region-asia-northeast2
--   2) bq query --use_legacy_sql=false --project_id=audeodb < 01_query_cost_by_job.sql
--
-- 注意:
--   - これは total_bytes_billed からの「推定」。実額は請求レポート or 05/06 の請求エクスポートで見る
--   - JOBS_BY_PROJECT の履歴保持は 180 日
--   - 定額(Editions/スロット)契約の場合は total_bytes_billed が課金と無関係になるので、この推定は使えない
--   - キャッシュヒットしたクエリは total_bytes_billed = 0（＝無料）
--   - 1テーブルあたり最低 10MB が課金対象になるため、極小クエリでも 0 にはならない

DECLARE usd_per_tib FLOAT64 DEFAULT 6.25;  -- オンデマンド分析の単価。US マルチリージョンの参考値。
                                           -- リージョンで異なるので https://cloud.google.com/bigquery/pricing で要確認
DECLARE lookback_days INT64 DEFAULT 30;

SELECT
  creation_time,
  user_email,
  job_id,
  statement_type,
  cache_hit,
  total_bytes_billed,
  ROUND(total_bytes_billed / POW(1024, 4), 4)               AS tib_billed,
  ROUND(total_bytes_billed / POW(1024, 4) * usd_per_tib, 4) AS est_usd,
  TIMESTAMP_DIFF(end_time, start_time, SECOND)              AS elapsed_sec,
  SUBSTR(REGEXP_REPLACE(query, r'\s+', ' '), 0, 200)        AS query_head
FROM `audeodb.region-asia-northeast1`.INFORMATION_SCHEMA.JOBS_BY_PROJECT
WHERE creation_time >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL lookback_days DAY)
  AND job_type = 'QUERY'
  AND state = 'DONE'
  AND error_result IS NULL
ORDER BY total_bytes_billed DESC
LIMIT 50;
