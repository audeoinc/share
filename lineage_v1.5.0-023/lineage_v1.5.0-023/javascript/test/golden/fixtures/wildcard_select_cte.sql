WITH base AS (
  SELECT order_id,
         amount * quantity AS gross_amount
  FROM `AUDEODB.SAMPLE_DS.SALES_ITEMS`
)
SELECT *
FROM base
