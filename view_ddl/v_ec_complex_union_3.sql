CREATE OR REPLACE VIEW `audeodb.sample_ds.v_ec_complex_union_3` AS
SELECT
  region,
  customer_segment,
  COUNT(*) AS customer_count,
  SUM(txn_count) AS total_txn_count,
  SUM(txn_total) AS total_sales,
  SUM(txn_total_with_tax) AS total_sales_with_tax,
  ROUND(AVG(txn_avg), 0) AS average_transaction_amount,
  ROUND(AVG(avg_last_3_orders), 0) AS average_recent_order_amount,
  MAX(region_total_sales) AS region_total_sales,
  COUNTIF(customer_class = 'VIP') AS vip_customer_count,
  COUNTIF(customer_class = '高額顧客') AS high_value_customer_count
FROM `audeodb.sample_ds.v_ec_complex_union_2`
GROUP BY
  region,
  customer_segment;