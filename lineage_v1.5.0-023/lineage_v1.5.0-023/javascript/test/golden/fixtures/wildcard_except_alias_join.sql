SELECT
  c.* EXCEPT(address),
  o.order_total
FROM `AUDEODB.SAMPLE_DS.CUSTOMERS` AS c
JOIN `AUDEODB.SAMPLE_DS.ORDERS` AS o
  ON c.customer_id = o.customer_id
