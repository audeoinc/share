SELECT * FROM (
  SELECT customer_id, category, amount
  FROM `AUDEODB.SAMPLE_DS.SALES`
)
PIVOT (
  SUM(amount) FOR category IN ('PC' AS pc_sales, 'AV' AS av_sales)
)
