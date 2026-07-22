WITH current_sales AS (
  SELECT order_id, amount
  FROM `AUDEODB.SAMPLE_DS.SALES_CURRENT`
),
archive_sales AS (
  SELECT legacy_order_id AS order_id, gross_amount AS amount
  FROM `AUDEODB.SAMPLE_DS.SALES_ARCHIVE`
)
SELECT order_id, amount
FROM current_sales

UNION ALL

SELECT order_id, amount
FROM archive_sales

UNION ALL

SELECT return_id, refund_amount
FROM `AUDEODB.SAMPLE_DS.SALES_RETURNS`
