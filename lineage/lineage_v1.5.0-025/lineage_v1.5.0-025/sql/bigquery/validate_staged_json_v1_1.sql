-- Validate the v1.1 staged JSON contract before publishing.
DECLARE target_analysis_id STRING DEFAULT 'ANALYSIS_ID';

SELECT
  analysis_id,
  JSON_VALUE(result_json, '$.analysis.analysis_status') AS analysis_status,
  JSON_VALUE(result_json, '$.analysis.view_name') AS json_view_name,
  ARRAY_LENGTH(JSON_QUERY_ARRAY(result_json, '$.exported_tables.tokens')) AS token_count,
  ARRAY_LENGTH(JSON_QUERY_ARRAY(result_json, '$.exported_tables.lineage_paths')) AS lineage_path_count,
  ARRAY_LENGTH(JSON_QUERY_ARRAY(result_json, '$.exported_tables.diagnostics')) AS diagnostic_count
FROM `YOUR_PROJECT.YOUR_DATASET.lineage_analysis_staging`
WHERE analysis_id = target_analysis_id;
