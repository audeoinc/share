SELECT
  customer_id,
  (
    SELECT MAX(order_total) AS internal_max_order_total
    FROM `AUDEODB.SAMPLE_DS.ORDERS`
  ) AS max_order_total
FROM `AUDEODB.SAMPLE_DS.CUSTOMERS`;
