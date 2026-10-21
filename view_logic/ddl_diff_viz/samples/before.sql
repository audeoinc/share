CREATE OR REPLACE VIEW `proj.mart.v_daily_sales` AS
WITH orders AS (
  SELECT
    order_id,
    customer_id,
    order_date,
    amount
  FROM `proj.raw.orders`
  WHERE order_date >= DATE '2025-01-01'
)
SELECT
  o.order_date,
  c.region,
  COUNT(DISTINCT o.order_id) AS order_count,
  SUM(o.amount)              AS gross_amount
FROM orders o
LEFT JOIN `proj.raw.customers` c
  ON o.customer_id = c.customer_id
GROUP BY o.order_date, c.region
ORDER BY o.order_date DESC
