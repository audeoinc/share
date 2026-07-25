SELECT
  order_id,
  unit_price * quantity AS amount
FROM `AUDEODB.SAMPLE_DS.SALES_CURRENT`

UNION ALL

SELECT
  legacy_order_id,
  gross_amount - discount_amount
FROM `AUDEODB.SAMPLE_DS.SALES_ARCHIVE`
