CREATE OR REPLACE VIEW `audeodb.sample_ds.v_ec_complex_union_2` AS
SELECT
  customer_id,
  customer_name,
  region,
  customer_segment,
  txn_count,
  txn_total,
  txn_avg,
  avg_last_3_orders,
  categories_bought,
  recent_order_chain,
  purchase_islands,
  rank_in_region,
  region_total_sales,
  pct_of_region,
  recent_chain,
  customer_class,
  ROUND(txn_total * 1.1, 0) AS txn_total_with_tax
FROM `audeodb.sample_ds.t_ec_complex_union`;