SELECT c.* REPLACE(UPPER(c.name) AS name), o.order_total
FROM `AUDEODB.SAMPLE_DS.CUSTOMERS` c
JOIN `AUDEODB.SAMPLE_DS.ORDERS` o ON c.customer_id = o.customer_id
