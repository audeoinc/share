WITH recent_orders AS (
  SELECT
    customer_id,
    order_total,
    order_date
  FROM `AUDEODB.SAMPLE_DS.ORDERS`
)
SELECT
  c.customer_id,
  (
    SELECT MAX(r.order_total) AS internal_max_recent_order
    FROM recent_orders AS r
    WHERE r.customer_id = c.customer_id
  ) AS max_recent_order
FROM `AUDEODB.SAMPLE_DS.CUSTOMERS` AS c;
