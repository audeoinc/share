-- Publish one staged analysis into normalized lineage tables.
--
-- Replace YOUR_PROJECT / YOUR_DATASET.
-- Set target_analysis_id to the analysis_id returned by run_single_view_analysis.sql.
--
-- This script is idempotent for one analysis_id: existing rows are deleted
-- before the staged JSON is expanded again.

DECLARE target_analysis_id STRING DEFAULT 'ANALYSIS_ID';

DECLARE result JSON DEFAULT (
  SELECT result_json
  FROM `YOUR_PROJECT.YOUR_DATASET.lineage_analysis_staging`
  WHERE analysis_id = target_analysis_id
  QUALIFY ROW_NUMBER() OVER (ORDER BY analyzed_at DESC) = 1
);

IF result IS NULL THEN
  RAISE USING MESSAGE = FORMAT(
    'No staged result_json was found for analysis_id=%s',
    target_analysis_id
  );
END IF;

BEGIN TRANSACTION;

DELETE FROM `YOUR_PROJECT.YOUR_DATASET.lineage_analyses`
WHERE analysis_id = target_analysis_id;
DELETE FROM `YOUR_PROJECT.YOUR_DATASET.lineage_tokens`
WHERE analysis_id = target_analysis_id;
DELETE FROM `YOUR_PROJECT.YOUR_DATASET.lineage_query_scopes`
WHERE analysis_id = target_analysis_id;
DELETE FROM `YOUR_PROJECT.YOUR_DATASET.lineage_sources`
WHERE analysis_id = target_analysis_id;
DELETE FROM `YOUR_PROJECT.YOUR_DATASET.lineage_cte_definitions`
WHERE analysis_id = target_analysis_id;
DELETE FROM `YOUR_PROJECT.YOUR_DATASET.lineage_column_references`
WHERE analysis_id = target_analysis_id;
DELETE FROM `YOUR_PROJECT.YOUR_DATASET.lineage_output_columns`
WHERE analysis_id = target_analysis_id;
DELETE FROM `YOUR_PROJECT.YOUR_DATASET.lineage_physical_column_references`
WHERE analysis_id = target_analysis_id;
DELETE FROM `YOUR_PROJECT.YOUR_DATASET.lineage_wildcard_expansions`
WHERE analysis_id = target_analysis_id;
DELETE FROM `YOUR_PROJECT.YOUR_DATASET.lineage_output_lineages`
WHERE analysis_id = target_analysis_id;
DELETE FROM `YOUR_PROJECT.YOUR_DATASET.lineage_paths`
WHERE analysis_id = target_analysis_id;
DELETE FROM `YOUR_PROJECT.YOUR_DATASET.lineage_impact_paths`
WHERE analysis_id = target_analysis_id;
DELETE FROM `YOUR_PROJECT.YOUR_DATASET.lineage_diagnostics`
WHERE analysis_id = target_analysis_id;

INSERT INTO `YOUR_PROJECT.YOUR_DATASET.lineage_analyses`
SELECT
  JSON_VALUE(row, '$.analysis_id'),
  JSON_VALUE(row, '$.view_project'),
  JSON_VALUE(row, '$.view_dataset'),
  JSON_VALUE(row, '$.view_name'),
  TIMESTAMP(JSON_VALUE(row, '$.analyzed_at')),
  JSON_VALUE(row, '$.analysis_status'),
  SAFE_CAST(JSON_VALUE(row, '$.strict_mode') AS BOOL),
  JSON_VALUE(row, '$.failed_stage'),
  SAFE_CAST(JSON_VALUE(row, '$.error_count') AS INT64),
  SAFE_CAST(JSON_VALUE(row, '$.warning_count') AS INT64),
  JSON_VALUE(row, '$.sql_text'),
  SAFE.PARSE_JSON(JSON_VALUE(row, '$.query_ast_json')),
  SAFE.PARSE_JSON(JSON_VALUE(row, '$.error_detail_json'))
FROM UNNEST([JSON_QUERY(result, '$.analysis')]) AS row
WHERE row IS NOT NULL;

INSERT INTO `YOUR_PROJECT.YOUR_DATASET.lineage_tokens`
SELECT
  JSON_VALUE(row, '$.analysis_id'),
  JSON_VALUE(row, '$.view_project'),
  JSON_VALUE(row, '$.view_dataset'),
  JSON_VALUE(row, '$.view_name'),
  TIMESTAMP(JSON_VALUE(row, '$.analyzed_at')),
  SAFE_CAST(JSON_VALUE(row, '$.token_seq') AS INT64),
  SAFE_CAST(JSON_VALUE(row, '$.line_no') AS INT64),
  SAFE_CAST(JSON_VALUE(row, '$.column_no') AS INT64),
  JSON_VALUE(row, '$.token'),
  JSON_VALUE(row, '$.normalized_token'),
  JSON_VALUE(row, '$.token_type'),
  SAFE_CAST(JSON_VALUE(row, '$.paren_depth') AS INT64)
FROM UNNEST(JSON_QUERY_ARRAY(result, '$.exported_tables.tokens')) AS row;

INSERT INTO `YOUR_PROJECT.YOUR_DATASET.lineage_query_scopes`
SELECT
  JSON_VALUE(row, '$.analysis_id'),
  JSON_VALUE(row, '$.view_project'),
  JSON_VALUE(row, '$.view_dataset'),
  JSON_VALUE(row, '$.view_name'),
  TIMESTAMP(JSON_VALUE(row, '$.analyzed_at')),
  SAFE_CAST(JSON_VALUE(row, '$.scope_id') AS INT64),
  JSON_VALUE(row, '$.scope_type'),
  SAFE_CAST(JSON_VALUE(row, '$.parent_scope_id') AS INT64),
  SAFE_CAST(JSON_VALUE(row, '$.query_start_token_seq') AS INT64),
  SAFE_CAST(JSON_VALUE(row, '$.query_end_token_seq') AS INT64)
FROM UNNEST(JSON_QUERY_ARRAY(result, '$.exported_tables.query_scopes')) AS row;

INSERT INTO `YOUR_PROJECT.YOUR_DATASET.lineage_sources`
SELECT
  JSON_VALUE(row, '$.analysis_id'),
  JSON_VALUE(row, '$.view_project'),
  JSON_VALUE(row, '$.view_dataset'),
  JSON_VALUE(row, '$.view_name'),
  TIMESTAMP(JSON_VALUE(row, '$.analyzed_at')),
  SAFE_CAST(JSON_VALUE(row, '$.source_id') AS INT64),
  SAFE_CAST(JSON_VALUE(row, '$.source_seq') AS INT64),
  SAFE_CAST(JSON_VALUE(row, '$.scope_id') AS INT64),
  JSON_VALUE(row, '$.source_role'),
  SAFE_CAST(JSON_VALUE(row, '$.join_seq') AS INT64),
  JSON_VALUE(row, '$.source_type'),
  JSON_VALUE(row, '$.source_name'),
  JSON_VALUE(row, '$.source_alias'),
  JSON_VALUE(row, '$.resolved_source_name'),
  SAFE_CAST(JSON_VALUE(row, '$.cte_query_scope_id') AS INT64),
  SAFE_CAST(JSON_VALUE(row, '$.subquery_scope_id') AS INT64),
  SAFE_CAST(JSON_VALUE(row, '$.start_token_seq') AS INT64),
  SAFE_CAST(JSON_VALUE(row, '$.end_token_seq') AS INT64),
  SAFE.PARSE_JSON(JSON_VALUE(row, '$.expression_json')),
  SAFE.PARSE_JSON(JSON_VALUE(row, '$.source_json'))
FROM UNNEST(JSON_QUERY_ARRAY(result, '$.exported_tables.sources')) AS row;

INSERT INTO `YOUR_PROJECT.YOUR_DATASET.lineage_cte_definitions`
SELECT
  JSON_VALUE(row, '$.analysis_id'),
  JSON_VALUE(row, '$.view_project'),
  JSON_VALUE(row, '$.view_dataset'),
  JSON_VALUE(row, '$.view_name'),
  TIMESTAMP(JSON_VALUE(row, '$.analyzed_at')),
  SAFE_CAST(JSON_VALUE(row, '$.scope_id') AS INT64),
  JSON_VALUE(row, '$.cte_name'),
  JSON_VALUE_ARRAY(row, '$.column_names'),
  SAFE_CAST(JSON_VALUE(row, '$.query_scope_id') AS INT64),
  SAFE_CAST(JSON_VALUE(row, '$.start_token_seq') AS INT64),
  SAFE_CAST(JSON_VALUE(row, '$.end_token_seq') AS INT64),
  SAFE.PARSE_JSON(JSON_VALUE(row, '$.cte_json'))
FROM UNNEST(JSON_QUERY_ARRAY(result, '$.exported_tables.cte_definitions')) AS row;

INSERT INTO `YOUR_PROJECT.YOUR_DATASET.lineage_column_references`
SELECT
  JSON_VALUE(row, '$.analysis_id'),
  JSON_VALUE(row, '$.view_project'),
  JSON_VALUE(row, '$.view_dataset'),
  JSON_VALUE(row, '$.view_name'),
  TIMESTAMP(JSON_VALUE(row, '$.analyzed_at')),
  SAFE_CAST(JSON_VALUE(row, '$.column_reference_id') AS INT64),
  SAFE_CAST(JSON_VALUE(row, '$.scope_id') AS INT64),
  JSON_VALUE(row, '$.clause_type'),
  SAFE_CAST(JSON_VALUE(row, '$.select_item_seq') AS INT64),
  SAFE_CAST(JSON_VALUE(row, '$.join_seq') AS INT64),
  SAFE_CAST(JSON_VALUE(row, '$.group_item_seq') AS INT64),
  SAFE_CAST(JSON_VALUE(row, '$.order_item_seq') AS INT64),
  JSON_VALUE(row, '$.reference_type'),
  JSON_VALUE(row, '$.reference_name'),
  JSON_VALUE(row, '$.qualifier'),
  JSON_VALUE(row, '$.column_name'),
  JSON_VALUE(row, '$.resolution_status'),
  SAFE_CAST(JSON_VALUE(row, '$.source_id') AS INT64),
  JSON_VALUE(row, '$.source_type'),
  JSON_VALUE(row, '$.source_name'),
  JSON_VALUE(row, '$.source_alias'),
  ARRAY(
    SELECT SAFE_CAST(value AS INT64)
    FROM UNNEST(JSON_VALUE_ARRAY(row, '$.candidate_source_ids')) AS value
  ),
  SAFE_CAST(JSON_VALUE(row, '$.start_token_seq') AS INT64),
  SAFE_CAST(JSON_VALUE(row, '$.end_token_seq') AS INT64),
  SAFE.PARSE_JSON(JSON_VALUE(row, '$.reference_json'))
FROM UNNEST(JSON_QUERY_ARRAY(result, '$.exported_tables.column_references')) AS row;

INSERT INTO `YOUR_PROJECT.YOUR_DATASET.lineage_output_columns`
SELECT
  JSON_VALUE(row, '$.analysis_id'),
  JSON_VALUE(row, '$.view_project'),
  JSON_VALUE(row, '$.view_dataset'),
  JSON_VALUE(row, '$.view_name'),
  TIMESTAMP(JSON_VALUE(row, '$.analyzed_at')),
  SAFE_CAST(JSON_VALUE(row, '$.output_column_id') AS INT64),
  SAFE_CAST(JSON_VALUE(row, '$.output_column_seq') AS INT64),
  SAFE_CAST(JSON_VALUE(row, '$.scope_id') AS INT64),
  JSON_VALUE(row, '$.output_column_name'),
  JSON_VALUE(row, '$.original_output_alias'),
  JSON_VALUE(row, '$.alias_type'),
  JSON_VALUE(row, '$.name_source'),
  JSON_VALUE(row, '$.output_status'),
  JSON_VALUE(row, '$.wildcard_type'),
  JSON_VALUE(row, '$.wildcard_qualifier'),
  JSON_VALUE(row, '$.expression_text'),
  SAFE_CAST(JSON_VALUE(row, '$.start_token_seq') AS INT64),
  SAFE_CAST(JSON_VALUE(row, '$.end_token_seq') AS INT64),
  SAFE.PARSE_JSON(JSON_VALUE(row, '$.expression_json')),
  SAFE.PARSE_JSON(JSON_VALUE(row, '$.output_column_json'))
FROM UNNEST(JSON_QUERY_ARRAY(result, '$.exported_tables.output_columns')) AS row;

INSERT INTO `YOUR_PROJECT.YOUR_DATASET.lineage_physical_column_references`
SELECT
  JSON_VALUE(row, '$.analysis_id'),
  JSON_VALUE(row, '$.view_project'),
  JSON_VALUE(row, '$.view_dataset'),
  JSON_VALUE(row, '$.view_name'),
  TIMESTAMP(JSON_VALUE(row, '$.analyzed_at')),
  SAFE_CAST(JSON_VALUE(row, '$.physical_reference_id') AS INT64),
  SAFE_CAST(JSON_VALUE(row, '$.column_reference_id') AS INT64),
  SAFE_CAST(JSON_VALUE(row, '$.scope_id') AS INT64),
  JSON_VALUE(row, '$.clause_type'),
  SAFE_CAST(JSON_VALUE(row, '$.select_item_seq') AS INT64),
  JSON_VALUE(row, '$.reference_type'),
  JSON_VALUE(row, '$.reference_name'),
  JSON_VALUE(row, '$.column_name'),
  JSON_VALUE(row, '$.original_resolution_status'),
  JSON_VALUE(row, '$.physical_resolution_status'),
  SAFE_CAST(JSON_VALUE(row, '$.source_id') AS INT64),
  JSON_VALUE(row, '$.source_type'),
  JSON_VALUE(row, '$.source_name'),
  JSON_VALUE(row, '$.source_alias'),
  ARRAY(
    SELECT SAFE_CAST(value AS INT64)
    FROM UNNEST(JSON_VALUE_ARRAY(row, '$.candidate_source_ids')) AS value
  ),
  SAFE_CAST(JSON_VALUE(row, '$.start_token_seq') AS INT64),
  SAFE_CAST(JSON_VALUE(row, '$.end_token_seq') AS INT64),
  SAFE.PARSE_JSON(JSON_VALUE(row, '$.physical_columns_json')),
  SAFE.PARSE_JSON(JSON_VALUE(row, '$.reference_json'))
FROM UNNEST(JSON_QUERY_ARRAY(result, '$.exported_tables.physical_column_references')) AS row;

INSERT INTO `YOUR_PROJECT.YOUR_DATASET.lineage_wildcard_expansions`
SELECT
  JSON_VALUE(row, '$.analysis_id'),
  JSON_VALUE(row, '$.view_project'),
  JSON_VALUE(row, '$.view_dataset'),
  JSON_VALUE(row, '$.view_name'),
  TIMESTAMP(JSON_VALUE(row, '$.analyzed_at')),
  SAFE_CAST(JSON_VALUE(row, '$.scope_id') AS INT64),
  SAFE_CAST(JSON_VALUE(row, '$.output_column_id') AS INT64),
  JSON_VALUE(row, '$.wildcard_type'),
  JSON_VALUE(row, '$.wildcard_qualifier'),
  SAFE_CAST(JSON_VALUE(row, '$.source_id') AS INT64),
  JSON_VALUE(row, '$.physical_table_name'),
  JSON_VALUE(row, '$.physical_column_name'),
  JSON_VALUE(row, '$.field_path'),
  SAFE.PARSE_JSON(JSON_VALUE(row, '$.expansion_json'))
FROM UNNEST(JSON_QUERY_ARRAY(result, '$.exported_tables.wildcard_expansions')) AS row;

INSERT INTO `YOUR_PROJECT.YOUR_DATASET.lineage_output_lineages`
SELECT
  JSON_VALUE(row, '$.analysis_id'),
  JSON_VALUE(row, '$.view_project'),
  JSON_VALUE(row, '$.view_dataset'),
  JSON_VALUE(row, '$.view_name'),
  TIMESTAMP(JSON_VALUE(row, '$.analyzed_at')),
  SAFE_CAST(JSON_VALUE(row, '$.lineage_id') AS INT64),
  SAFE_CAST(JSON_VALUE(row, '$.output_column_id') AS INT64),
  SAFE_CAST(JSON_VALUE(row, '$.output_scope_id') AS INT64),
  SAFE_CAST(JSON_VALUE(row, '$.output_column_seq') AS INT64),
  JSON_VALUE(row, '$.output_column_name'),
  JSON_VALUE(row, '$.expression_text'),
  JSON_VALUE(row, '$.lineage_status'),
  JSON_VALUE_ARRAY(row, '$.lineage_path'),
  SAFE_CAST(JSON_VALUE(row, '$.start_token_seq') AS INT64),
  SAFE_CAST(JSON_VALUE(row, '$.end_token_seq') AS INT64),
  SAFE.PARSE_JSON(JSON_VALUE(row, '$.dependencies_json')),
  SAFE.PARSE_JSON(JSON_VALUE(row, '$.output_lineage_json'))
FROM UNNEST(JSON_QUERY_ARRAY(result, '$.exported_tables.output_lineages')) AS row;

INSERT INTO `YOUR_PROJECT.YOUR_DATASET.lineage_paths`
SELECT
  JSON_VALUE(row, '$.analysis_id'),
  JSON_VALUE(row, '$.view_project'),
  JSON_VALUE(row, '$.view_dataset'),
  JSON_VALUE(row, '$.view_name'),
  TIMESTAMP(JSON_VALUE(row, '$.analyzed_at')),
  SAFE_CAST(JSON_VALUE(row, '$.output_column_id') AS INT64),
  JSON_VALUE(row, '$.output_column_name'),
  SAFE_CAST(JSON_VALUE(row, '$.output_scope_id') AS INT64),
  JSON_VALUE(row, '$.physical_table_name'),
  JSON_VALUE(row, '$.physical_column_name'),
  JSON_VALUE(row, '$.field_path'),
  JSON_VALUE_ARRAY(row, '$.lineage_path'),
  SAFE.PARSE_JSON(JSON_VALUE(row, '$.lineage_path_json'))
FROM UNNEST(JSON_QUERY_ARRAY(result, '$.exported_tables.lineage_paths')) AS row;

INSERT INTO `YOUR_PROJECT.YOUR_DATASET.lineage_impact_paths`
SELECT
  JSON_VALUE(row, '$.analysis_id'),
  JSON_VALUE(row, '$.view_project'),
  JSON_VALUE(row, '$.view_dataset'),
  JSON_VALUE(row, '$.view_name'),
  TIMESTAMP(JSON_VALUE(row, '$.analyzed_at')),
  SAFE_CAST(JSON_VALUE(row, '$.output_column_id') AS INT64),
  JSON_VALUE(row, '$.output_column_name'),
  SAFE_CAST(JSON_VALUE(row, '$.output_scope_id') AS INT64),
  JSON_VALUE(row, '$.physical_table_name'),
  JSON_VALUE(row, '$.physical_column_name'),
  JSON_VALUE(row, '$.field_path'),
  JSON_VALUE_ARRAY(row, '$.impact_path'),
  SAFE.PARSE_JSON(JSON_VALUE(row, '$.impact_path_json'))
FROM UNNEST(JSON_QUERY_ARRAY(result, '$.exported_tables.impact_paths')) AS row;

INSERT INTO `YOUR_PROJECT.YOUR_DATASET.lineage_diagnostics`
SELECT
  JSON_VALUE(row, '$.analysis_id'),
  JSON_VALUE(row, '$.view_project'),
  JSON_VALUE(row, '$.view_dataset'),
  JSON_VALUE(row, '$.view_name'),
  TIMESTAMP(JSON_VALUE(row, '$.analyzed_at')),
  SAFE_CAST(JSON_VALUE(row, '$.diagnostic_seq') AS INT64),
  JSON_VALUE(row, '$.severity'),
  JSON_VALUE(row, '$.code'),
  JSON_VALUE(row, '$.message'),
  JSON_VALUE(row, '$.stage'),
  JSON_VALUE(row, '$.error_name'),
  SAFE.PARSE_JSON(JSON_VALUE(row, '$.diagnostic_json'))
FROM UNNEST(JSON_QUERY_ARRAY(result, '$.exported_tables.diagnostics')) AS row;

UPDATE `YOUR_PROJECT.YOUR_DATASET.lineage_analysis_staging`
SET published_at = CURRENT_TIMESTAMP()
WHERE analysis_id = target_analysis_id;

COMMIT TRANSACTION;
