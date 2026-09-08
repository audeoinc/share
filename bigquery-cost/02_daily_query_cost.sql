-- 02: 日次のクエリ課金バイト／推定費用の推移
--     「いつ跳ねたか」を見るためのトレンド用。まずこれを見て、跳ねた日を 01 で掘る。
--
-- 使い方: PROJECT / REGION を書き換えて実行（01 と同じ）

DECLARE usd_per_tib FLOAT64 DEFAULT 6.25;
DECLARE lookback_days INT64 DEFAULT 30;

SELECT
  DATE(creation_time)                                            AS day,
  COUNT(*)                                                       AS jobs,
  COUNTIF(cache_hit)                                             AS cached_jobs,
  ROUND(SUM(total_bytes_billed) / POW(1024, 4), 4)               AS tib_billed,
  ROUND(SUM(total_bytes_billed) / POW(1024, 4) * usd_per_tib, 4) AS est_usd
FROM `audeodb.region-asia-northeast1`.INFORMATION_SCHEMA.JOBS_BY_PROJECT
WHERE creation_time >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL lookback_days DAY)
  AND job_type = 'QUERY'
  AND state = 'DONE'
GROUP BY day
ORDER BY day DESC;
