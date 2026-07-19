CREATE OR REPLACE VIEW `audeodb.sample_ds.v_ec_union_transactions` AS
-- Union を使って「売上」「返金」を統合したトランザクション一覧を作成
WITH base AS (
  SELECT
    h.order_id,
    h.customer_id,
    c.customer_name,
    c.region,
    h.purchase_date,
    ROUND(h.unit_price * h.quantity * (1 - h.discount_rate), 0) AS sales_amount,
    p.category AS product_category,
    h.order_status
  FROM `audeodb.sample_ds.customer_purchase_history` AS h
  JOIN `audeodb.sample_ds.customer_master` AS c
    ON h.customer_id = c.customer_id
  JOIN `audeodb.sample_ds.product_master` AS p
    ON h.product_id = p.product_id
)
SELECT
  order_id,
  customer_id,
  customer_name,
  region,
  purchase_date,
  sales_amount AS amount,
  product_category,
  'sale' AS txn_type
FROM base
WHERE order_status = 'completed'
UNION ALL
SELECT
  order_id,
  customer_id,
  customer_name,
  region,
  purchase_date,
  -sales_amount AS amount,
  product_category,
  'refund' AS txn_type
FROM base
WHERE LOWER(order_status) IN ('refunded','refund','returned') OR order_status = 'refunded';
