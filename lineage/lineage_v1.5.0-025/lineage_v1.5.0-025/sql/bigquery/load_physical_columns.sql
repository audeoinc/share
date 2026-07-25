-- Load or refresh physical column metadata for one dataset.
--
-- Replace:
--   SOURCE_PROJECT
--   SOURCE_DATASET
--   YOUR_PROJECT
--   YOUR_DATASET
--
-- Run this once for every source dataset referenced by the Views being analyzed.

BEGIN TRANSACTION;

DELETE FROM `YOUR_PROJECT.YOUR_DATASET.lineage_physical_columns_catalog`
WHERE table_project = 'SOURCE_PROJECT'
  AND table_dataset = 'SOURCE_DATASET';

INSERT INTO `YOUR_PROJECT.YOUR_DATASET.lineage_physical_columns_catalog` (
  table_project,
  table_dataset,
  table_name,
  column_name,
  field_path,
  ordinal_position,
  data_type,
  is_nullable,
  metadata_loaded_at
)
SELECT
  table_catalog AS table_project,
  table_schema AS table_dataset,
  table_name,
  column_name,
  column_name AS field_path,
  ordinal_position,
  data_type,
  is_nullable,
  CURRENT_TIMESTAMP()
FROM `SOURCE_PROJECT.SOURCE_DATASET.INFORMATION_SCHEMA.COLUMNS`;

COMMIT TRANSACTION;

-- Optional nested-field enrichment:
-- COLUMN_FIELD_PATHS can be loaded in a separate MERGE if nested STRUCT fields
-- must be resolved individually.
