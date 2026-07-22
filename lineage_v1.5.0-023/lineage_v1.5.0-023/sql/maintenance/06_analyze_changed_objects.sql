-- ============================================================================
-- 06_analyze_changed_objects.sql
-- EXECUTION ORDER: Initial setup 08 / Daily operation 03
-- ============================================================================
SET @@location = 'asia-northeast1';

-- ============================================================================
-- Changed definitions -> persistent lineage UDF -> direct dependency repository
--
-- Design principles:
--   - No explicit transaction.
--   - Re-runnable and idempotent.
--   - Existing dependencies are not touched until UDF parsing and staging finish.
--   - Dependency replacement uses DELETE + INSERT.
--   - If replacement DML fails inside the object block, the previous dependency
--     rows are restored from temporary backup tables.
--   - is_changed becomes FALSE only after dependency and diagnostic persistence
--     both finish successfully.
--
-- Current environment-dependent values:
--   - Repository dataset: audeodb.lineage_repository
--   - Metadata dataset:   audeodb.sample_ds
--   - Persistent UDF:     audeodb.sample_ds.analyze_lineage_json
--
-- These values will be moved to lineage_config when the integrated setup and
-- daily-operation SQL files are implemented.
-- ============================================================================

DECLARE run_started_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP();
DECLARE strict_mode BOOL DEFAULT FALSE;
DECLARE physical_columns_json STRING;
DECLARE analyzed_object_count INT64 DEFAULT 0;
DECLARE failed_object_count INT64 DEFAULT 0;

-- --------------------------------------------------------------------------
-- Physical-column metadata passed to the JavaScript lineage engine.
-- --------------------------------------------------------------------------
SET physical_columns_json = (
  WITH top_level_columns AS (
    SELECT
      table_catalog AS table_project,
      table_schema AS table_dataset,
      table_name,
      column_name,
      column_name AS field_path,
      ordinal_position,
      data_type,
      is_nullable
    FROM `audeodb.sample_ds.INFORMATION_SCHEMA.COLUMNS`
  ),
  nested_field_paths AS (
    SELECT
      field.table_catalog AS table_project,
      field.table_schema AS table_dataset,
      field.table_name,
      field.column_name,
      field.field_path,
      column_info.ordinal_position,
      field.data_type,
      CAST(NULL AS STRING) AS is_nullable
    FROM `audeodb.sample_ds.INFORMATION_SCHEMA.COLUMN_FIELD_PATHS` AS field
    LEFT JOIN `audeodb.sample_ds.INFORMATION_SCHEMA.COLUMNS` AS column_info
      ON column_info.table_catalog = field.table_catalog
     AND column_info.table_schema = field.table_schema
     AND column_info.table_name = field.table_name
     AND column_info.column_name = field.column_name
    WHERE field.field_path IS NOT NULL
      AND field.field_path != field.column_name
      AND STRPOS(field.field_path, '.') > 0
  ),
  physical_columns_source AS (
    SELECT * FROM top_level_columns
    UNION ALL
    SELECT * FROM nested_field_paths
  )
  SELECT COALESCE(
    TO_JSON_STRING(
      ARRAY_AGG(
        STRUCT(
          LOWER(FORMAT(
            '%s.%s.%s',
            table_project,
            table_dataset,
            table_name
          )) AS table_name,
          LOWER(column_name) AS column_name,
          LOWER(field_path) AS field_path,
          ordinal_position AS ordinal_position,
          data_type AS data_type,
          is_nullable AS is_nullable
        )
        ORDER BY
          table_project,
          table_dataset,
          table_name,
          ordinal_position,
          field_path
      )
    ),
    '[]'
  )
  FROM physical_columns_source
);

-- --------------------------------------------------------------------------
-- Remove repository rows whose target definition is no longer active.
-- --------------------------------------------------------------------------
DELETE FROM
  `audeodb.lineage_repository.lineage_direct_dependency` AS dependency
WHERE NOT EXISTS (
  SELECT 1
  FROM
    `audeodb.lineage_repository.lineage_definition_registry` AS registry
  WHERE registry.is_active = TRUE
    AND LOWER(registry.object_project) = LOWER(dependency.target_project)
    AND LOWER(registry.object_dataset) = LOWER(dependency.target_dataset)
    AND LOWER(registry.object_name) = LOWER(dependency.target_object)
    AND registry.object_type = dependency.target_object_type
    AND registry.generation_type = dependency.generation_type
);

DELETE FROM
  `audeodb.lineage_repository.lineage_diagnostic` AS diagnostic
WHERE NOT EXISTS (
  SELECT 1
  FROM
    `audeodb.lineage_repository.lineage_definition_registry` AS registry
  WHERE registry.is_active = TRUE
    AND LOWER(registry.object_project) = LOWER(diagnostic.object_project)
    AND LOWER(registry.object_dataset) = LOWER(diagnostic.object_dataset)
    AND LOWER(registry.object_name) = LOWER(diagnostic.object_name)
    AND registry.object_type = diagnostic.object_type
);

-- --------------------------------------------------------------------------
-- Analyze active definitions whose current definition has changed.
-- --------------------------------------------------------------------------
FOR target IN (
  SELECT
    object_project,
    object_dataset,
    object_name,
    object_type,
    generation_type,
    definition_text,
    definition_hash
  FROM
    `audeodb.lineage_repository.lineage_definition_registry`
  WHERE is_active = TRUE
    AND is_changed = TRUE
    AND definition_text IS NOT NULL
    AND object_type IN ('VIEW', 'TABLE')
  ORDER BY
    object_project,
    object_dataset,
    object_name,
    generation_type
)
DO
  BEGIN
    DECLARE analysis_id STRING DEFAULT GENERATE_UUID();
    DECLARE analyzed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP();
    DECLARE exported_json STRING;
    DECLARE udf_analysis_status STRING;
    DECLARE replacement_started BOOL DEFAULT FALSE;

    SET exported_json = `audeodb.sample_ds.analyze_lineage_json`(
      target.definition_text,
      physical_columns_json,
      TO_JSON_STRING(STRUCT(
        strict_mode AS strict_mode,
        TRUE AS compact_export
      )),
      TO_JSON_STRING(STRUCT(
        analysis_id AS analysis_id,
        target.object_project AS view_project,
        target.object_dataset AS view_dataset,
        target.object_name AS view_name,
        FORMAT_TIMESTAMP(
          '%FT%H:%M:%E*S%Ez',
          analyzed_at
        ) AS analyzed_at
      ))
    );

    SET udf_analysis_status = COALESCE(
      JSON_VALUE(exported_json, '$.analysis.analysis_status'),
      'UNKNOWN'
    );

    IF udf_analysis_status NOT IN (
      'COMPLETED',
      'COMPLETED_WITH_WARNINGS'
    ) THEN
      RAISE USING MESSAGE = FORMAT(
        'Lineage analysis was not publishable. status=%s',
        udf_analysis_status
      );
    END IF;

    CREATE OR REPLACE TEMP TABLE staged_direct_dependency AS
    WITH lineage_path_rows AS (
      SELECT
        SAFE_CAST(JSON_VALUE(path_row, '$.output_column_id') AS INT64)
          AS output_column_id,
        SAFE_CAST(JSON_VALUE(path_row, '$.output_scope_id') AS INT64)
          AS output_scope_id,
        JSON_VALUE(path_row, '$.output_column_name') AS output_column_name,
        JSON_VALUE(path_row, '$.physical_table_name') AS physical_table_name,
        JSON_VALUE(path_row, '$.physical_column_name') AS physical_column_name,
        JSON_VALUE(path_row, '$.field_path') AS field_path
      FROM UNNEST(
        JSON_QUERY_ARRAY(
          exported_json,
          '$.exported_tables.lineage_paths'
        )
      ) AS path_row
    ),
    output_lineage_rows AS (
      SELECT
        SAFE_CAST(JSON_VALUE(output_row, '$.output_column_id') AS INT64)
          AS output_column_id,
        SAFE_CAST(JSON_VALUE(output_row, '$.output_scope_id') AS INT64)
          AS output_scope_id,
        JSON_VALUE(output_row, '$.expression_text') AS expression_text,
        JSON_VALUE(output_row, '$.lineage_status') AS lineage_status
      FROM UNNEST(
        JSON_QUERY_ARRAY(
          exported_json,
          '$.exported_tables.output_lineages'
        )
      ) AS output_row
    ),
    parsed_edges AS (
      SELECT
        target.definition_hash AS definition_hash,
        LOWER(
          CASE ARRAY_LENGTH(SPLIT(path.physical_table_name, '.'))
            WHEN 3 THEN SPLIT(path.physical_table_name, '.')[SAFE_OFFSET(0)]
            ELSE target.object_project
          END
        ) AS source_project,
        LOWER(
          CASE ARRAY_LENGTH(SPLIT(path.physical_table_name, '.'))
            WHEN 3 THEN SPLIT(path.physical_table_name, '.')[SAFE_OFFSET(1)]
            WHEN 2 THEN SPLIT(path.physical_table_name, '.')[SAFE_OFFSET(0)]
            ELSE target.object_dataset
          END
        ) AS source_dataset,
        LOWER(
          CASE ARRAY_LENGTH(SPLIT(path.physical_table_name, '.'))
            WHEN 3 THEN SPLIT(path.physical_table_name, '.')[SAFE_OFFSET(2)]
            WHEN 2 THEN SPLIT(path.physical_table_name, '.')[SAFE_OFFSET(1)]
            ELSE SPLIT(path.physical_table_name, '.')[SAFE_OFFSET(0)]
          END
        ) AS source_object,
        LOWER(
          COALESCE(path.field_path, path.physical_column_name)
        ) AS source_column,
        LOWER(target.object_project) AS target_project,
        LOWER(target.object_dataset) AS target_dataset,
        LOWER(target.object_name) AS target_object,
        target.object_type AS target_object_type,
        LOWER(path.output_column_name) AS target_column,
        target.generation_type AS generation_type,
        'COLUMN' AS dependency_type,
        output.expression_text AS expression,
        'SELECT' AS usage_type,
        COALESCE(output.lineage_status, 'RESOLVED')
          AS resolution_status,
        CAST(NULL AS STRING) AS resolution_reason,
        analyzed_at AS analyzed_at
      FROM lineage_path_rows AS path
      LEFT JOIN output_lineage_rows AS output
        ON output.output_column_id = path.output_column_id
       AND output.output_scope_id = path.output_scope_id
      WHERE path.physical_table_name IS NOT NULL
        AND path.output_column_name IS NOT NULL
    ),
    normalized_edges AS (
      SELECT
        parsed.* EXCEPT(target_object_type),
        CASE
          WHEN source_registry.object_type = 'VIEW' THEN 'VIEW'
          WHEN source_table.table_type = 'VIEW' THEN 'VIEW'
          ELSE 'TABLE'
        END AS source_object_type,
        parsed.target_object_type
      FROM parsed_edges AS parsed
      LEFT JOIN
        `audeodb.lineage_repository.lineage_definition_registry`
          AS source_registry
        ON source_registry.is_active = TRUE
       AND LOWER(source_registry.object_project) = parsed.source_project
       AND LOWER(source_registry.object_dataset) = parsed.source_dataset
       AND LOWER(source_registry.object_name) = parsed.source_object
       AND source_registry.object_type = 'VIEW'
      LEFT JOIN
        `audeodb.sample_ds.INFORMATION_SCHEMA.TABLES` AS source_table
        ON LOWER(source_table.table_catalog) = parsed.source_project
       AND LOWER(source_table.table_schema) = parsed.source_dataset
       AND LOWER(source_table.table_name) = parsed.source_object
      QUALIFY ROW_NUMBER() OVER (
        PARTITION BY
          parsed.definition_hash,
          parsed.source_project,
          parsed.source_dataset,
          parsed.source_object,
          parsed.source_column,
          parsed.target_project,
          parsed.target_dataset,
          parsed.target_object,
          parsed.target_column,
          parsed.generation_type
        ORDER BY
          source_registry.updated_at DESC NULLS LAST
      ) = 1
    )
    SELECT DISTINCT
      definition_hash,
      source_project,
      source_dataset,
      source_object,
      source_object_type,
      source_column,
      target_project,
      target_dataset,
      target_object,
      target_object_type,
      target_column,
      generation_type,
      dependency_type,
      expression,
      usage_type,
      resolution_status,
      resolution_reason,
      TO_HEX(SHA256(CONCAT(
        COALESCE(source_project, ''), '|',
        COALESCE(source_dataset, ''), '|',
        COALESCE(source_object, ''), '|',
        COALESCE(source_column, '*'), '|',
        COALESCE(target_project, ''), '|',
        COALESCE(target_dataset, ''), '|',
        COALESCE(target_object, ''), '|',
        COALESCE(target_column, '*'), '|',
        generation_type
      ))) AS edge_key,
      analyzed_at
    FROM normalized_edges;

    CREATE OR REPLACE TEMP TABLE staged_lineage_diagnostic AS
    SELECT
      target.definition_hash AS definition_hash,
      LOWER(target.object_project) AS object_project,
      LOWER(target.object_dataset) AS object_dataset,
      LOWER(target.object_name) AS object_name,
      target.object_type AS object_type,
      COALESCE(JSON_VALUE(diagnostic_row, '$.code'), 'UNKNOWN')
        AS diagnostic_code,
      JSON_VALUE(diagnostic_row, '$.stage') AS engine_stage,
      COALESCE(JSON_VALUE(diagnostic_row, '$.severity'), 'INFO')
        AS severity,
      CAST(NULL AS STRING) AS output_column,
      CAST(NULL AS STRING) AS expression,
      JSON_VALUE(diagnostic_row, '$.message') AS message,
      SAFE.PARSE_JSON(
        JSON_VALUE(diagnostic_row, '$.diagnostic_json')
      ) AS diagnostic_json,
      analyzed_at AS analyzed_at
    FROM UNNEST(
      JSON_QUERY_ARRAY(
        exported_json,
        '$.exported_tables.diagnostics'
      )
    ) AS diagnostic_row;

    CREATE OR REPLACE TEMP TABLE previous_direct_dependency AS
    SELECT *
    FROM
      `audeodb.lineage_repository.lineage_direct_dependency`
    WHERE LOWER(target_project) = LOWER(target.object_project)
      AND LOWER(target_dataset) = LOWER(target.object_dataset)
      AND LOWER(target_object) = LOWER(target.object_name)
      AND target_object_type = target.object_type
      AND generation_type = target.generation_type;

    CREATE OR REPLACE TEMP TABLE previous_lineage_diagnostic AS
    SELECT *
    FROM
      `audeodb.lineage_repository.lineage_diagnostic`
    WHERE LOWER(object_project) = LOWER(target.object_project)
      AND LOWER(object_dataset) = LOWER(target.object_dataset)
      AND LOWER(object_name) = LOWER(target.object_name)
      AND object_type = target.object_type;

    SET replacement_started = TRUE;

    DELETE FROM
      `audeodb.lineage_repository.lineage_direct_dependency`
    WHERE LOWER(target_project) = LOWER(target.object_project)
      AND LOWER(target_dataset) = LOWER(target.object_dataset)
      AND LOWER(target_object) = LOWER(target.object_name)
      AND target_object_type = target.object_type
      AND generation_type = target.generation_type;

    INSERT INTO
      `audeodb.lineage_repository.lineage_direct_dependency`
    SELECT *
    FROM staged_direct_dependency;

    DELETE FROM
      `audeodb.lineage_repository.lineage_diagnostic`
    WHERE LOWER(object_project) = LOWER(target.object_project)
      AND LOWER(object_dataset) = LOWER(target.object_dataset)
      AND LOWER(object_name) = LOWER(target.object_name)
      AND object_type = target.object_type;

    INSERT INTO
      `audeodb.lineage_repository.lineage_diagnostic`
    SELECT *
    FROM staged_lineage_diagnostic;

    UPDATE
      `audeodb.lineage_repository.lineage_definition_registry`
    SET
      is_changed = FALSE,
      analysis_status = udf_analysis_status,
      last_analyzed_hash = definition_hash,
      last_analyzed_at = analyzed_at,
      updated_at = analyzed_at
    WHERE LOWER(object_project) = LOWER(target.object_project)
      AND LOWER(object_dataset) = LOWER(target.object_dataset)
      AND LOWER(object_name) = LOWER(target.object_name)
      AND object_type = target.object_type
      AND generation_type = target.generation_type
      AND definition_hash = target.definition_hash;

    SET analyzed_object_count = analyzed_object_count + 1;

  EXCEPTION WHEN ERROR THEN
    IF replacement_started THEN
      DELETE FROM
        `audeodb.lineage_repository.lineage_direct_dependency`
      WHERE LOWER(target_project) = LOWER(target.object_project)
        AND LOWER(target_dataset) = LOWER(target.object_dataset)
        AND LOWER(target_object) = LOWER(target.object_name)
        AND target_object_type = target.object_type
        AND generation_type = target.generation_type;

      INSERT INTO
        `audeodb.lineage_repository.lineage_direct_dependency`
      SELECT *
      FROM previous_direct_dependency;

      DELETE FROM
        `audeodb.lineage_repository.lineage_diagnostic`
      WHERE LOWER(object_project) = LOWER(target.object_project)
        AND LOWER(object_dataset) = LOWER(target.object_dataset)
        AND LOWER(object_name) = LOWER(target.object_name)
        AND object_type = target.object_type;

      INSERT INTO
        `audeodb.lineage_repository.lineage_diagnostic`
      SELECT *
      FROM previous_lineage_diagnostic;
    END IF;

    UPDATE
      `audeodb.lineage_repository.lineage_definition_registry`
    SET
      is_changed = TRUE,
      analysis_status = 'FAILED',
      updated_at = CURRENT_TIMESTAMP()
    WHERE LOWER(object_project) = LOWER(target.object_project)
      AND LOWER(object_dataset) = LOWER(target.object_dataset)
      AND LOWER(object_name) = LOWER(target.object_name)
      AND object_type = target.object_type
      AND generation_type = target.generation_type
      AND definition_hash = target.definition_hash;

    INSERT INTO
      `audeodb.lineage_repository.lineage_diagnostic`
    (
      definition_hash,
      object_project,
      object_dataset,
      object_name,
      object_type,
      diagnostic_code,
      engine_stage,
      severity,
      output_column,
      expression,
      message,
      diagnostic_json,
      analyzed_at
    )
    VALUES (
      target.definition_hash,
      LOWER(target.object_project),
      LOWER(target.object_dataset),
      LOWER(target.object_name),
      target.object_type,
      'ANALYSIS_EXECUTION_FAILED',
      '06_analyze_changed_objects',
      'ERROR',
      NULL,
      NULL,
      @@error.message,
      JSON_OBJECT(
        'statement_text', @@error.statement_text,
        'formatted_stack_trace', @@error.formatted_stack_trace
      ),
      CURRENT_TIMESTAMP()
    );

    SET failed_object_count = failed_object_count + 1;
  END;
END FOR;

-- --------------------------------------------------------------------------
-- Run summary.
-- 04_rebuild_impact_table.sql is executed after this script in daily operation.
-- --------------------------------------------------------------------------
SELECT
  run_started_at,
  CURRENT_TIMESTAMP() AS run_finished_at,
  analyzed_object_count,
  failed_object_count,
  (
    SELECT COUNT(*)
    FROM
      `audeodb.lineage_repository.lineage_definition_registry`
    WHERE is_active = TRUE
      AND is_changed = TRUE
  ) AS remaining_changed_object_count,
  (
    SELECT COUNT(*)
    FROM
      `audeodb.lineage_repository.lineage_direct_dependency`
  ) AS direct_dependency_count,
  (
    SELECT COUNT(*)
    FROM
      `audeodb.lineage_repository.lineage_diagnostic`
    WHERE severity = 'ERROR'
  ) AS error_diagnostic_count;
