-- 06: 請求データエクスポートからサービス別の実額（BigQuery 以外もまとめて確認）
--     このプロジェクトで実際に効いているのは Vertex AI と Cloud Run のはずなので、
--     「BQ が高いのか、そうでないのか」の切り分けにまずこれを見るとよい。
--
-- 前提・テーブル名の置き換えは 05 と同じ。

DECLARE lookback_days INT64 DEFAULT 30;

SELECT
  service.description AS service,
  project.id          AS project_id,
  ROUND(SUM(cost), 4) AS cost_usd,
  ROUND(SUM(cost) + SUM(IFNULL((SELECT SUM(c.amount) FROM UNNEST(credits) c), 0)), 4) AS net_usd
FROM `audeodb.billing.gcp_billing_export_v1_XXXXXX_XXXXXX_XXXXXX`
WHERE usage_start_time >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL lookback_days DAY)
GROUP BY service, project_id
ORDER BY net_usd DESC;
