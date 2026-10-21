CREATE OR REPLACE VIEW `proj.mart.v_daily_sales` AS
WITH orders AS (
  SELECT
    order_id,
    customer_id,
    order_date,
    amount,
    currency
  FROM `proj.raw.orders`
  WHERE order_date >= DATE '2025-04-01'
    AND status = 'CONFIRMED'
)
SELECT
  o.order_date,
  c.region,
  o.currency,
  COUNT(DISTINCT o.order_id) AS order_count,
  SUM(o.amount)              AS gross_amount,
  SUM(o.amount) / NULLIF(COUNT(DISTINCT o.order_id), 0) AS avg_amount
FROM orders o
LEFT JOIN `proj.raw.customers` c
  ON o.customer_id = c.customer_id
GROUP BY o.order_date, c.region, o.currency
ORDER BY o.order_date DESC
