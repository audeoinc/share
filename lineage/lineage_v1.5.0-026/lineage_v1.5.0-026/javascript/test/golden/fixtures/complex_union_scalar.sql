WITH combined AS (
  SELECT order_id, amount
  FROM `AUDEODB.SAMPLE_DS.SALES_CURRENT`
  UNION ALL
  SELECT legacy_order_id AS order_id, gross_amount AS amount
  FROM `AUDEODB.SAMPLE_DS.SALES_ARCHIVE`
)
SELECT
  order_id,
  amount,
  (SELECT MAX(max_amount) FROM `AUDEODB.SAMPLE_DS.LIMITS`) AS global_limit
FROM combined
