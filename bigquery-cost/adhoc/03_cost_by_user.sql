-- 03: 実行者（ユーザー / サービスアカウント）別の集計
--     「誰の実行が効いているか」＝バッチ・アプリ・人手の切り分けに使う。
--
-- 使い方: PROJECT / REGION を書き換えて実行（01 と同じ）

DECLARE usd_per_tib FLOAT64 DEFAULT 6.25;
DECLARE lookback_days INT64 DEFAULT 30;

SELECT
  user_email,
  COUNT(*)                                                       AS jobs,
  ROUND(SUM(total_bytes_billed) / POW(1024, 4), 4)               AS tib_billed,
  ROUND(SUM(total_bytes_billed) / POW(1024, 4) * usd_per_tib, 4) AS est_usd,
  ROUND(AVG(total_bytes_billed) / POW(1024, 3), 2)               AS avg_gib_per_job,
  MAX(creation_time)                                             AS last_run
FROM `audeodb.region-asia-northeast1`.INFORMATION_SCHEMA.JOBS_BY_PROJECT
WHERE creation_time >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL lookback_days DAY)
  AND job_type = 'QUERY'
  AND state = 'DONE'
GROUP BY user_email
ORDER BY tib_billed DESC;
