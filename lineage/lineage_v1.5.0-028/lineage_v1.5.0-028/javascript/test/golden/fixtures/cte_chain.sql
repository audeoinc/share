WITH base AS (
  SELECT customer_id, unit_price, quantity
  FROM `AUDEODB.SAMPLE_DS.CUSTOMER_PURCHASE_HISTORY`
), calculated AS (
  SELECT customer_id, unit_price * quantity AS gross_amount
  FROM base
)
SELECT customer_id, SUM(gross_amount) AS total_amount
FROM calculated
GROUP BY customer_id
