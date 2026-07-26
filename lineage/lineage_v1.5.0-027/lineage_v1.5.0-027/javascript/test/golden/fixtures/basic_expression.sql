SELECT
  order_id,
  unit_price * quantity * (1 - discount_rate) AS net_amount
FROM `AUDEODB.SAMPLE_DS.CUSTOMER_PURCHASE_HISTORY`
