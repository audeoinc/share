SELECT * REPLACE(amount * 1.1 AS amount, UPPER(status) AS status)
FROM `AUDEODB.SAMPLE_DS.ORDERS`
