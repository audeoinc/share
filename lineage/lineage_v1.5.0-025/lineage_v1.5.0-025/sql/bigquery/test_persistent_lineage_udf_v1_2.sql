-- Replace project, dataset and function names for your environment.
-- Both rows should return COMPLETED and failed_stage should be NULL.

WITH test_cases AS (
  SELECT
    'array_subquery_and_unnest' AS test_name,
    '''
SELECT
  CASE
    WHEN c.customer_id IS NOT NULL THEN ARRAY_TO_STRING(
      ARRAY(
        SELECT item
        FROM UNNEST(c.items) AS item
      ),
      ','
    )
    ELSE ''
  END AS item_list,
FROM `project.dataset.customers` AS c
''' AS sql_text

  UNION ALL

  SELECT
    'correlated_scalar_subquery',
    '''
SELECT
  c.customer_id,
  (
    SELECT MAX(o.order_date)
    FROM `project.dataset.orders` AS o
    WHERE o.customer_id = c.customer_id
  ) AS last_order_date,
FROM `project.dataset.customers` AS c
'''
)
SELECT
  test_name,
  JSON_VALUE(result_json, '$.analysis.analysis_status') AS analysis_status,
  JSON_VALUE(result_json, '$.analysis.failed_stage') AS failed_stage,
  ARRAY_LENGTH(
    JSON_QUERY_ARRAY(result_json, '$.exported_tables.query_scopes')
  ) AS query_scope_count,
  JSON_QUERY(result_json, '$.exported_tables.diagnostics') AS diagnostics
FROM (
  SELECT
    test_name,
    `YOUR_PROJECT.YOUR_DATASET.analyze_lineage`(
      sql_text,
      '[]',
      '{"strict_mode":false}',
      TO_JSON_STRING(STRUCT(
        CONCAT('v1_2_test_', test_name) AS analysis_id,
        'PROJECT' AS view_project,
        'DATASET' AS view_dataset,
        'TEST_VIEW' AS view_name,
        CURRENT_TIMESTAMP() AS analyzed_at
      ))
    ) AS result_json
  FROM test_cases
);
