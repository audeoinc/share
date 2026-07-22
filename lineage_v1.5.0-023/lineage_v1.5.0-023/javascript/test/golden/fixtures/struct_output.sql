SELECT
  customer_id,
  STRUCT(order_id AS id, purchase_date AS purchased_at) AS order_info
FROM `AUDEODB.SAMPLE_DS.CUSTOMER_PURCHASE_HISTORY`
