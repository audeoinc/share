amount BETWEEN 10 AND 20
AND status NOT IN ('CANCELLED', 'DELETED')
OR customer_id IN (
  SELECT customer_id
  FROM customers
)
