-- Analyze a single View and save the complete exported JSON to staging.
--
-- Replace:
--   TARGET_PROJECT / TARGET_DATASET / TARGET_VIEW
--   YOUR_PROJECT / YOUR_DATASET
--
-- Prerequisites:
--   1. create_lineage_tables.sql
--   2. create_pipeline_tables.sql
--   3. create_persistent_lineage_udf.sql
--   4. lineage_physical_columns_catalog has been populated.

DECLARE target_project STRING DEFAULT 'TARGET_PROJECT';
DECLARE target_dataset STRING DEFAULT 'TARGET_DATASET';
DECLARE target_view STRING DEFAULT 'TARGET_VIEW';
DECLARE strict_mode BOOL DEFAULT FALSE;

DECLARE analysis_id STRING DEFAULT GENERATE_UUID();
DECLARE analyzed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP();
DECLARE view_sql STRING;
DECLARE physical_columns_json STRING;
DECLARE exported_json STRING;

-- Dataset identifiers cannot be supplied as normal query parameters, so
-- EXECUTE IMMEDIATE is used only for reading INFORMATION_SCHEMA.VIEWS.
EXECUTE IMMEDIATE FORMAT("""
  SELECT view_definition
  FROM `%s.%s.INFORMATION_SCHEMA.VIEWS`
  WHERE table_name = @view_name
""", target_project, target_dataset)
INTO view_sql
USING target_view AS view_name;

IF view_sql IS NULL THEN
  RAISE USING MESSAGE = FORMAT(
    'View was not found: %s.%s.%s',
    target_project,
    target_dataset,
    target_view
  );
END IF;

SET physical_columns_json = (
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
      ORDER BY
        table_project,
        table_dataset,
        table_name,
        ordinal_position,
        field_path
    )
  )
  FROM `YOUR_PROJECT.YOUR_DATASET.lineage_physical_columns_catalog`
);

BEGIN
  SET exported_json = `YOUR_PROJECT.YOUR_DATASET.analyze_lineage_json`(
    view_sql,
    COALESCE(physical_columns_json, '[]'),
    TO_JSON_STRING(STRUCT(
      strict_mode AS strict_mode,
      TRUE AS compact_export
    )),
    TO_JSON_STRING(STRUCT(
      analysis_id AS analysis_id,
      target_project AS view_project,
      target_dataset AS view_dataset,
      target_view AS view_name,
      FORMAT_TIMESTAMP(
        '%FT%H:%M:%E*S%Ez',
        analyzed_at
      ) AS analyzed_at
    ))
  );

  INSERT INTO `YOUR_PROJECT.YOUR_DATASET.lineage_analysis_staging` (
    analysis_id,
    view_project,
    view_dataset,
    view_name,
    view_definition,
    result_json,
    analysis_status,
    error_message,
    analyzed_at
  )
  VALUES (
    analysis_id,
    target_project,
    target_dataset,
    target_view,
    view_sql,
    SAFE.PARSE_JSON(exported_json),
    COALESCE(
      JSON_VALUE(exported_json, '$.analysis.analysis_status'),
      'UNKNOWN'
    ),
    NULL,
    analyzed_at
  );

EXCEPTION WHEN ERROR THEN
  INSERT INTO `YOUR_PROJECT.YOUR_DATASET.lineage_analysis_staging` (
    analysis_id,
    view_project,
    view_dataset,
    view_name,
    view_definition,
    result_json,
    analysis_status,
    error_message,
    analyzed_at
  )
  VALUES (
    analysis_id,
    target_project,
    target_dataset,
    target_view,
    view_sql,
    NULL,
    'FAILED',
    @@error.message,
    analyzed_at
  );

  RAISE;
END;

SELECT analysis_id AS created_analysis_id;
