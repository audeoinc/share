SELECT
  c.customer_id,
  EXISTS(
    SELECT 1 AS exists_marker
    FROM `AUDEODB.SAMPLE_DS.ORDERS` AS o
    WHERE o.customer_id = c.customer_id
  ) AS has_order
FROM `AUDEODB.SAMPLE_DS.CUSTOMERS` AS c;
