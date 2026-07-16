CASE WHEN amount > 0 THEN IF(flag, amount, 0) ELSE 0 END
old_value IS NOT DISTINCT FROM new_value
EXISTS (SELECT 1 FROM sales WHERE amount > 0)
