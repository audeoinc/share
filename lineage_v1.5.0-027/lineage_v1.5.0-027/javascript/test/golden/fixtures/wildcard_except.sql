SELECT * EXCEPT(discount_rate),
       unit_price * quantity AS gross_amount
FROM `AUDEODB.SAMPLE_DS.CUSTOMER_PURCHASE_HISTORY`
