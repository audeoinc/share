-- BigQuery View Lineage Pipeline: staging / metadata tables
--
-- Replace:
--   YOUR_PROJECT
--   YOUR_DATASET
--
-- The physical column catalog is intentionally separated from the analysis
-- results. Populate it from every project/dataset that may appear in View SQL.

CREATE TABLE IF NOT EXISTS `YOUR_PROJECT.YOUR_DATASET.lineage_analysis_staging` (
  analysis_id STRING NOT NULL,
  view_project STRING NOT NULL,
  view_dataset STRING NOT NULL,
  view_name STRING NOT NULL,
  view_definition STRING,
  result_json JSON,
  analysis_status STRING,
  error_message STRING,
  analyzed_at TIMESTAMP NOT NULL,
  published_at TIMESTAMP
)
PARTITION BY DATE(analyzed_at)
CLUSTER BY view_project, view_dataset, view_name, analysis_id;

CREATE TABLE IF NOT EXISTS `YOUR_PROJECT.YOUR_DATASET.lineage_physical_columns_catalog` (
  table_project STRING NOT NULL,
  table_dataset STRING NOT NULL,
  table_name STRING NOT NULL,
  column_name STRING NOT NULL,
  field_path STRING,
  ordinal_position INT64,
  data_type STRING,
  is_nullable STRING,
  metadata_loaded_at TIMESTAMP NOT NULL
)
PARTITION BY DATE(metadata_loaded_at)
CLUSTER BY table_project, table_dataset, table_name, column_name;
