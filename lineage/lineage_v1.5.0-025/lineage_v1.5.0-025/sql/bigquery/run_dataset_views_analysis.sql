-- Analyze all Views in one dataset and keep one staging row per View.
--
-- This v1 script deliberately separates staging from publishing:
--   1. Execute this file.
--   2. Publish successful analysis_ids with publish_staged_analysis.sql.
--
-- Replace TARGET_PROJECT / TARGET_DATASET / YOUR_PROJECT / YOUR_DATASET.

DECLARE target_project STRING DEFAULT 'TARGET_PROJECT';
DECLARE target_dataset STRING DEFAULT 'TARGET_DATASET';
DECLARE strict_mode BOOL DEFAULT FALSE;

DECLARE physical_columns_json STRING DEFAULT (
  SELECT TO_JSON_STRING(
    ARRAY_AGG(
      STRUCT(
        UPPER(FORMAT(
          '%s.%s.%s',
          table_project,
          table_dataset,
          table_name
        )) AS table_name,
        UPPER(column_name) AS column_name,
        UPPER(COALESCE(field_path, column_name)) AS field_path
      )
    )
  )
  FROM `YOUR_PROJECT.YOUR_DATASET.lineage_physical_columns_catalog`
);

CREATE TEMP TABLE target_views (
  view_name STRING,
  view_definition STRING
);

EXECUTE IMMEDIATE FORMAT("""
  INSERT INTO target_views
  SELECT table_name, view_definition
  FROM `%s.%s.INFORMATION_SCHEMA.VIEWS`
""", target_project, target_dataset);

FOR target IN (
  SELECT view_name, view_definition
  FROM target_views
  ORDER BY view_name
)
DO
  BEGIN
    DECLARE analysis_id STRING DEFAULT GENERATE_UUID();
    DECLARE analyzed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP();
    DECLARE exported_json STRING;

    SET exported_json = `YOUR_PROJECT.YOUR_DATASET.analyze_lineage_json`(
      target.view_definition,
      COALESCE(physical_columns_json, '[]'),
      TO_JSON_STRING(STRUCT(
      strict_mode AS strict_mode,
      TRUE AS compact_export
    )),
      TO_JSON_STRING(STRUCT(
        analysis_id AS analysis_id,
        target_project AS view_project,
        target_dataset AS view_dataset,
        target.view_name AS view_name,
        FORMAT_TIMESTAMP(
          '%FT%H:%M:%E*S%Ez',
          analyzed_at
        ) AS analyzed_at
      ))
    );

    INSERT INTO `YOUR_PROJECT.YOUR_DATASET.lineage_analysis_staging` (
      analysis_id, view_project, view_dataset, view_name, view_definition,
      result_json, analysis_status, error_message, analyzed_at, published_at
    )
    VALUES (
      analysis_id,
      target_project,
      target_dataset,
      target.view_name,
      target.view_definition,
      SAFE.PARSE_JSON(exported_json),
      COALESCE(
        JSON_VALUE(exported_json, '$.analysis.analysis_status'),
        'UNKNOWN'
      ),
      NULL,
      analyzed_at,
      NULL
    );

  EXCEPTION WHEN ERROR THEN
    INSERT INTO `YOUR_PROJECT.YOUR_DATASET.lineage_analysis_staging` (
      analysis_id, view_project, view_dataset, view_name, view_definition,
      result_json, analysis_status, error_message, analyzed_at, published_at
    )
    VALUES (
      GENERATE_UUID(),
      target_project,
      target_dataset,
      target.view_name,
      target.view_definition,
      NULL,
      'FAILED',
      @@error.message,
      CURRENT_TIMESTAMP(),
      NULL
    );
  END;
END FOR;

SELECT
  analysis_status,
  COUNT(*) AS view_count
FROM `YOUR_PROJECT.YOUR_DATASET.lineage_analysis_staging`
WHERE view_project = target_project
  AND view_dataset = target_dataset
  AND analyzed_at >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 1 DAY)
GROUP BY analysis_status
ORDER BY analysis_status;
