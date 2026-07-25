SELECT
  c.customer_id,
  CASE
    WHEN EXISTS (
      SELECT 1
      FROM `AUDEODB.SAMPLE_DS.ORDERS` AS o
      WHERE o.customer_id = c.customer_id
        AND o.order_total > 100
    ) THEN UPPER(c.name)
    ELSE c.region
  END AS customer_label
FROM `AUDEODB.SAMPLE_DS.CUSTOMERS` AS c
