SELECT *
FROM (
  SELECT customer_id,
         order_total
  FROM `AUDEODB.SAMPLE_DS.ORDERS`
)
