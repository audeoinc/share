SELECT
  c.region,
  SUM(h.unit_price * h.quantity) AS region_sales
FROM `AUDEODB.SAMPLE_DS.CUSTOMER_PURCHASE_HISTORY` h
JOIN `AUDEODB.SAMPLE_DS.CUSTOMER_MASTER` c
  ON h.customer_id = c.customer_id
GROUP BY c.region
