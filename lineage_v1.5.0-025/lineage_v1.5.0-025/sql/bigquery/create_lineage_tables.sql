-- BigQuery Lineage Engine 保存先テーブルDDL
--
-- 置換対象:
--   `YOUR_PROJECT.YOUR_DATASET`
--
-- 設計方針:
-- - JOINや検索に利用する主要項目は通常列として保持する。
-- - ASTなど将来形が変わる可能性のある構造はJSON列へ保存する。
-- - 全テーブルにanalysis_idと解析対象View情報を持たせる。

CREATE TABLE IF NOT EXISTS `YOUR_PROJECT.YOUR_DATASET.lineage_analyses` (
  analysis_id STRING NOT NULL,
  view_project STRING,
  view_dataset STRING,
  view_name STRING,
  analyzed_at TIMESTAMP NOT NULL,
  analysis_status STRING,
  strict_mode BOOL,
  failed_stage STRING,
  error_count INT64,
  warning_count INT64,
  sql_text STRING,
  query_ast_json JSON,
  error_detail_json JSON
)
PARTITION BY DATE(analyzed_at)
CLUSTER BY view_project, view_dataset, view_name, analysis_id;

CREATE TABLE IF NOT EXISTS `YOUR_PROJECT.YOUR_DATASET.lineage_tokens` (
  analysis_id STRING NOT NULL,
  view_project STRING,
  view_dataset STRING,
  view_name STRING,
  analyzed_at TIMESTAMP NOT NULL,
  token_seq INT64,
  line_no INT64,
  column_no INT64,
  token STRING,
  normalized_token STRING,
  token_type STRING,
  paren_depth INT64
)
PARTITION BY DATE(analyzed_at)
CLUSTER BY analysis_id, token_seq;

CREATE TABLE IF NOT EXISTS `YOUR_PROJECT.YOUR_DATASET.lineage_query_scopes` (
  analysis_id STRING NOT NULL,
  view_project STRING,
  view_dataset STRING,
  view_name STRING,
  analyzed_at TIMESTAMP NOT NULL,
  scope_id INT64,
  scope_type STRING,
  parent_scope_id INT64,
  query_start_token_seq INT64,
  query_end_token_seq INT64
)
PARTITION BY DATE(analyzed_at)
CLUSTER BY analysis_id, scope_id;

CREATE TABLE IF NOT EXISTS `YOUR_PROJECT.YOUR_DATASET.lineage_sources` (
  analysis_id STRING NOT NULL,
  view_project STRING,
  view_dataset STRING,
  view_name STRING,
  analyzed_at TIMESTAMP NOT NULL,
  source_id INT64,
  source_seq INT64,
  scope_id INT64,
  source_role STRING,
  join_seq INT64,
  source_type STRING,
  source_name STRING,
  source_alias STRING,
  resolved_source_name STRING,
  cte_query_scope_id INT64,
  subquery_scope_id INT64,
  start_token_seq INT64,
  end_token_seq INT64,
  expression_json JSON,
  source_json JSON
)
PARTITION BY DATE(analyzed_at)
CLUSTER BY analysis_id, scope_id, source_alias;

CREATE TABLE IF NOT EXISTS `YOUR_PROJECT.YOUR_DATASET.lineage_cte_definitions` (
  analysis_id STRING NOT NULL,
  view_project STRING,
  view_dataset STRING,
  view_name STRING,
  analyzed_at TIMESTAMP NOT NULL,
  scope_id INT64,
  cte_name STRING,
  column_names ARRAY<STRING>,
  query_scope_id INT64,
  start_token_seq INT64,
  end_token_seq INT64,
  cte_json JSON
)
PARTITION BY DATE(analyzed_at)
CLUSTER BY analysis_id, scope_id, cte_name;

CREATE TABLE IF NOT EXISTS `YOUR_PROJECT.YOUR_DATASET.lineage_column_references` (
  analysis_id STRING NOT NULL,
  view_project STRING,
  view_dataset STRING,
  view_name STRING,
  analyzed_at TIMESTAMP NOT NULL,
  column_reference_id INT64,
  scope_id INT64,
  clause_type STRING,
  select_item_seq INT64,
  join_seq INT64,
  group_item_seq INT64,
  order_item_seq INT64,
  reference_type STRING,
  reference_name STRING,
  qualifier STRING,
  column_name STRING,
  resolution_status STRING,
  source_id INT64,
  source_type STRING,
  source_name STRING,
  source_alias STRING,
  candidate_source_ids ARRAY<INT64>,
  start_token_seq INT64,
  end_token_seq INT64,
  reference_json JSON
)
PARTITION BY DATE(analyzed_at)
CLUSTER BY analysis_id, scope_id, column_name;

CREATE TABLE IF NOT EXISTS `YOUR_PROJECT.YOUR_DATASET.lineage_output_columns` (
  analysis_id STRING NOT NULL,
  view_project STRING,
  view_dataset STRING,
  view_name STRING,
  analyzed_at TIMESTAMP NOT NULL,
  output_column_id INT64,
  output_column_seq INT64,
  scope_id INT64,
  output_column_name STRING,
  original_output_alias STRING,
  alias_type STRING,
  name_source STRING,
  output_status STRING,
  wildcard_type STRING,
  wildcard_qualifier STRING,
  expression_text STRING,
  start_token_seq INT64,
  end_token_seq INT64,
  expression_json JSON,
  output_column_json JSON
)
PARTITION BY DATE(analyzed_at)
CLUSTER BY analysis_id, scope_id, output_column_name;

CREATE TABLE IF NOT EXISTS `YOUR_PROJECT.YOUR_DATASET.lineage_physical_column_references` (
  analysis_id STRING NOT NULL,
  view_project STRING,
  view_dataset STRING,
  view_name STRING,
  analyzed_at TIMESTAMP NOT NULL,
  physical_reference_id INT64,
  column_reference_id INT64,
  scope_id INT64,
  clause_type STRING,
  select_item_seq INT64,
  reference_type STRING,
  reference_name STRING,
  column_name STRING,
  original_resolution_status STRING,
  physical_resolution_status STRING,
  source_id INT64,
  source_type STRING,
  source_name STRING,
  source_alias STRING,
  candidate_source_ids ARRAY<INT64>,
  start_token_seq INT64,
  end_token_seq INT64,
  physical_columns_json JSON,
  reference_json JSON
)
PARTITION BY DATE(analyzed_at)
CLUSTER BY analysis_id, scope_id, column_name;

CREATE TABLE IF NOT EXISTS `YOUR_PROJECT.YOUR_DATASET.lineage_wildcard_expansions` (
  analysis_id STRING NOT NULL,
  view_project STRING,
  view_dataset STRING,
  view_name STRING,
  analyzed_at TIMESTAMP NOT NULL,
  scope_id INT64,
  output_column_id INT64,
  wildcard_type STRING,
  wildcard_qualifier STRING,
  source_id INT64,
  physical_table_name STRING,
  physical_column_name STRING,
  field_path STRING,
  expansion_json JSON
)
PARTITION BY DATE(analyzed_at)
CLUSTER BY analysis_id, physical_table_name, physical_column_name;

CREATE TABLE IF NOT EXISTS `YOUR_PROJECT.YOUR_DATASET.lineage_output_lineages` (
  analysis_id STRING NOT NULL,
  view_project STRING,
  view_dataset STRING,
  view_name STRING,
  analyzed_at TIMESTAMP NOT NULL,
  lineage_id INT64,
  output_column_id INT64,
  output_scope_id INT64,
  output_column_seq INT64,
  output_column_name STRING,
  expression_text STRING,
  lineage_status STRING,
  lineage_path ARRAY<STRING>,
  start_token_seq INT64,
  end_token_seq INT64,
  dependencies_json JSON,
  output_lineage_json JSON
)
PARTITION BY DATE(analyzed_at)
CLUSTER BY analysis_id, output_scope_id, output_column_name;

CREATE TABLE IF NOT EXISTS `YOUR_PROJECT.YOUR_DATASET.lineage_paths` (
  analysis_id STRING NOT NULL,
  view_project STRING,
  view_dataset STRING,
  view_name STRING,
  analyzed_at TIMESTAMP NOT NULL,
  output_column_id INT64,
  output_column_name STRING,
  output_scope_id INT64,
  physical_table_name STRING,
  physical_column_name STRING,
  field_path STRING,
  lineage_path ARRAY<STRING>,
  lineage_path_json JSON
)
PARTITION BY DATE(analyzed_at)
CLUSTER BY physical_table_name, physical_column_name, view_name;

CREATE TABLE IF NOT EXISTS `YOUR_PROJECT.YOUR_DATASET.lineage_impact_paths` (
  analysis_id STRING NOT NULL,
  view_project STRING,
  view_dataset STRING,
  view_name STRING,
  analyzed_at TIMESTAMP NOT NULL,
  output_column_id INT64,
  output_column_name STRING,
  output_scope_id INT64,
  physical_table_name STRING,
  physical_column_name STRING,
  field_path STRING,
  impact_path ARRAY<STRING>,
  impact_path_json JSON
)
PARTITION BY DATE(analyzed_at)
CLUSTER BY physical_table_name, physical_column_name, view_name;

CREATE TABLE IF NOT EXISTS `YOUR_PROJECT.YOUR_DATASET.lineage_diagnostics` (
  analysis_id STRING NOT NULL,
  view_project STRING,
  view_dataset STRING,
  view_name STRING,
  analyzed_at TIMESTAMP NOT NULL,
  diagnostic_seq INT64,
  severity STRING,
  code STRING,
  message STRING,
  stage STRING,
  error_name STRING,
  diagnostic_json JSON
)
PARTITION BY DATE(analyzed_at)
CLUSTER BY analysis_id, severity, code;
