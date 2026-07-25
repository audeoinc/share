SELECT
  customer_id,
  credit_limit + (
    SELECT AVG(order_total) AS internal_avg_order_total
    FROM `AUDEODB.SAMPLE_DS.ORDERS`
  ) AS adjusted_limit
FROM `AUDEODB.SAMPLE_DS.CUSTOMERS`;
