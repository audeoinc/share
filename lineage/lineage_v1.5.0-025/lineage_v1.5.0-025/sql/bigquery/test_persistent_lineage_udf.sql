-- ============================================================================
-- 永続UDFの最小疎通テスト
--
-- YOUR_PROJECT / YOUR_DATASETを書き換えて実行してください。
-- 成功時はJSON文字列が1行返ります。
-- ============================================================================

SELECT
  `YOUR_PROJECT.YOUR_DATASET.analyze_lineage_json`(
    'SELECT customer_id, SUM(amount) AS total_amount FROM `project.dataset.sales` GROUP BY customer_id',
    TO_JSON_STRING([
      STRUCT(
        'project' AS table_catalog,
        'dataset' AS table_schema,
        'sales' AS table_name,
        'customer_id' AS column_name,
        1 AS ordinal_position,
        'INT64' AS data_type
      ),
      STRUCT(
        'project' AS table_catalog,
        'dataset' AS table_schema,
        'sales' AS table_name,
        'amount' AS column_name,
        2 AS ordinal_position,
        'NUMERIC' AS data_type
      )
    ]),
    '{"strict_mode":false}',
    NULL
  ) AS result_json;
