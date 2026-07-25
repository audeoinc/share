-- ============================================================================
-- GCS外部JavaScriptライブラリ版 永続UDF
--
-- 実行前に次の3箇所を書き換えてください。
--   YOUR_PROJECT
--   YOUR_DATASET
--   gs://YOUR_BUCKET/YOUR_PATH/lineage_udf_bundle.js
-- ============================================================================

CREATE OR REPLACE FUNCTION
  `YOUR_PROJECT.YOUR_DATASET.analyze_lineage_json`(
    sql_text STRING,
    physical_columns_json STRING,
    options_json STRING,
    export_metadata_json STRING
  )
RETURNS STRING
LANGUAGE js
OPTIONS (
  library = [
    'gs://YOUR_BUCKET/YOUR_PATH/lineage_udf_bundle.js'
  ]
)
AS r"""
  return analyzeLineageForBigQuery(
    sql_text,
    physical_columns_json,
    options_json,
    export_metadata_json
  );
""";
