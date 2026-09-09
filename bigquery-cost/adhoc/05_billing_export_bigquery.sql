-- 05: 請求データエクスポートから BigQuery の「実額」を出す（SKU 内訳つき）
--     推定ではなく、割引・クレジット適用後の実費。これが最も正確。
--
-- 前提:
--   Cloud Console → お支払い → 課金データのエクスポート → 「標準の使用料金」を BigQuery に出力しておく。
--   設定した時点以降のデータしか入らない（過去には遡れない）ので、まだなら先に有効化する。
--
-- 使い方:
--   下のテーブル名を自分のエクスポート先に置き換える。
--   形式: `<project>.<dataset>.gcp_billing_export_v1_<BILLING_ACCOUNT_ID をアンダースコア化したもの>`
--   例:   `audeodb.billing.gcp_billing_export_v1_012345_6789AB_CDEF01`

DECLARE lookback_days INT64 DEFAULT 30;

SELECT
  sku.description                                       AS sku,
  ROUND(SUM(cost), 4)                                   AS cost_usd,
  ROUND(SUM(IFNULL((SELECT SUM(c.amount) FROM UNNEST(credits) c), 0)), 4) AS credits_usd,
  ROUND(SUM(cost) + SUM(IFNULL((SELECT SUM(c.amount) FROM UNNEST(credits) c), 0)), 4) AS net_usd,
  ANY_VALUE(usage.unit)                                 AS usage_unit,
  ROUND(SUM(usage.amount), 2)                           AS usage_amount
FROM `audeodb.billing.gcp_billing_export_v1_XXXXXX_XXXXXX_XXXXXX`
WHERE service.description = 'BigQuery'
  AND usage_start_time >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL lookback_days DAY)
  -- プロジェクトを絞りたい場合:
  -- AND project.id = 'audeodb'
GROUP BY sku
ORDER BY net_usd DESC;
