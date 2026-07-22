SELECT
  c.customer_id,
  (
    SELECT MAX(o.order_total) AS internal_max_order_total
    FROM `AUDEODB.SAMPLE_DS.ORDERS` AS o
    WHERE o.customer_id = c.customer_id
  ) AS max_order_total
FROM `AUDEODB.SAMPLE_DS.CUSTOMERS` AS c;
