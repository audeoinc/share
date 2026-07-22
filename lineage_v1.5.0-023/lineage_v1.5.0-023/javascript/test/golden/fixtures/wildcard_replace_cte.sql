WITH base AS (
  SELECT order_id, amount, quantity
  FROM `AUDEODB.SAMPLE_DS.SALES_ITEMS`
)
SELECT * REPLACE(amount * quantity AS amount)
FROM base
