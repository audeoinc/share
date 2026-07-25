-- ============================================================================
-- 03_run_daily_lineage_pipeline.sql
-- BigQuery Physical Lineage Repository - Daily multi-statement pipeline
-- ============================================================================
-- IMPORTANT:
-- @@location must be set before statements that access BigQuery resources.
-- Keep this value equal to job_region below.
SET @@location = 'asia-northeast1';

-- ============================================================================
-- Common dynamic SQL renderer
-- ============================================================================
-- Only SQL identifiers are replaced here.
-- Runtime values must continue to be passed with EXECUTE IMMEDIATE ... USING.
CREATE TEMP FUNCTION render_dynamic_sql(
  sql_template STRING,
  repository_project_id STRING,
  repository_dataset STRING,
  target_project_id STRING,
  target_dataset STRING,
  job_region STRING,
  udf_project_id STRING,
  udf_dataset STRING,
  udf_function_name STRING
)
RETURNS STRING
AS (
  REPLACE(
    REPLACE(
      REPLACE(
        REPLACE(
          REPLACE(
            sql_template,
            '__REPOSITORY__',
            repository_project_id || '.' || repository_dataset
          ),
          '__TARGET__',
          target_project_id || '.' || target_dataset
        ),
        '__TARGET_PROJECT__',
        target_project_id
      ),
      '__JOB_REGION__',
      job_region
    ),
    '__UDF__',
    udf_project_id || '.' || udf_dataset || '.' || udf_function_name
  )
);

BEGIN
-- ============================================================================
-- Runtime environment settings
-- ============================================================================
-- These scalar values are intentionally defined in this script.
-- 03 does not read lineage_config, avoiding two sources of truth.
DECLARE repository_project_id STRING DEFAULT 'audeodb';
DECLARE repository_dataset STRING DEFAULT 'lineage_repository';
DECLARE target_project_id STRING DEFAULT 'audeodb';
DECLARE target_dataset STRING DEFAULT 'sample_ds';
DECLARE job_region STRING DEFAULT 'asia-northeast1';
DECLARE udf_project_id STRING DEFAULT 'audeodb';
DECLARE udf_dataset STRING DEFAULT 'sample_ds';
DECLARE udf_function_name STRING DEFAULT 'analyze_lineage_json';
DECLARE parser_strict_mode BOOL DEFAULT FALSE;
DECLARE configured_max_impact_rank INT64 DEFAULT 100;

-- Dynamic SQL work variables.
-- Identifier replacement is centralized in render_dynamic_sql().
DECLARE sql_template STRING;
DECLARE rendered_sql STRING;

-- Repository tables can be referenced without repeating project and dataset.
SET @@dataset_project_id = repository_project_id;
SET @@dataset_id = repository_dataset;

ASSERT @@location = job_region
AS '@@location and job_region must be identical.';
ASSERT REGEXP_CONTAINS(repository_project_id, r'^[A-Za-z0-9._:-]+$')
AS 'Invalid repository_project_id.';
ASSERT REGEXP_CONTAINS(repository_dataset, r'^[A-Za-z0-9_]+$')
AS 'Invalid repository_dataset.';
ASSERT REGEXP_CONTAINS(target_project_id, r'^[A-Za-z0-9._:-]+$')
AS 'Invalid target_project_id.';
ASSERT REGEXP_CONTAINS(target_dataset, r'^[A-Za-z0-9_]+$')
AS 'Invalid target_dataset.';
ASSERT REGEXP_CONTAINS(job_region, r'^[A-Za-z0-9-]+$')
AS 'Invalid job_region.';
ASSERT REGEXP_CONTAINS(udf_project_id, r'^[A-Za-z0-9._:-]+$')
AS 'Invalid udf_project_id.';
ASSERT REGEXP_CONTAINS(udf_dataset, r'^[A-Za-z0-9_]+$')
AS 'Invalid udf_dataset.';
ASSERT REGEXP_CONTAINS(udf_function_name, r'^[A-Za-z0-9_]+$')
AS 'Invalid udf_function_name.';
ASSERT configured_max_impact_rank BETWEEN 1 AND 1000
AS 'configured_max_impact_rank must be between 1 and 1000.';

-- Execution order:
--   1. Synchronize View definitions
--   2. Synchronize Scheduled Query / DAG generated-table definitions
--   3. Analyze changed definitions
--   4. Rebuild ranked impact paths
--
-- Scalar environment settings are maintained above.
-- Multi-valued execution accounts remain table-managed.
-- Dynamic SQL execution convention:
--   1. SET sql_template
--   2. SET rendered_sql = render_dynamic_sql(...)
--   3. ASSERT that no placeholder remains
--   4. EXECUTE IMMEDIATE rendered_sql [INTO ...] [USING ...]
-- Dynamic SQL placeholders:
--   __REPOSITORY__     -> repository project.dataset
--   __TARGET__         -> target project.dataset
--   __TARGET_PROJECT__ -> target project
--   __JOB_REGION__     -> BigQuery location without the region- prefix
--   __UDF__            -> UDF project.dataset.function

-- ============================================================================
-- STEP 1: Synchronize View definitions
-- ============================================================================
BEGIN
  DECLARE step_started_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP();

  -- Dataset and region are identifiers, so metadata sources are materialized
  -- through dynamic SQL into stable temporary tables.
  SET sql_template = """
    CREATE OR REPLACE TEMP TABLE current_view_definitions AS
    SELECT
      LOWER(table_catalog) AS object_project,
      LOWER(table_schema) AS object_dataset,
      LOWER(table_name) AS object_name,
      'VIEW' AS object_type,
      'VIEW_DEFINITION' AS generation_type,
      'INFORMATION_SCHEMA.VIEWS' AS definition_source,
      view_definition AS definition_text,
      TO_HEX(SHA256(view_definition)) AS definition_hash
    FROM `__TARGET__.INFORMATION_SCHEMA.VIEWS`
    WHERE view_definition IS NOT NULL
      AND TRIM(view_definition) != ''
  """;

  SET rendered_sql = render_dynamic_sql(
    sql_template,
    repository_project_id,
    repository_dataset,
    target_project_id,
    target_dataset,
    job_region,
    udf_project_id,
    udf_dataset,
    udf_function_name
  );

  ASSERT NOT REGEXP_CONTAINS(rendered_sql, r'__[A-Z0-9_]+__')
  AS 'Unresolved placeholder in current_view_definitions SQL.';

  EXECUTE IMMEDIATE rendered_sql;

  SET sql_template = """
    CREATE OR REPLACE TEMP TABLE current_target_tables AS
    SELECT
      LOWER(table_catalog) AS table_catalog,
      LOWER(table_schema) AS table_schema,
      LOWER(table_name) AS table_name,
      table_type
    FROM `__TARGET_PROJECT__.region-__JOB_REGION__`.INFORMATION_SCHEMA.TABLES
  """;

  SET rendered_sql = render_dynamic_sql(
    sql_template,
    repository_project_id,
    repository_dataset,
    target_project_id,
    target_dataset,
    job_region,
    udf_project_id,
    udf_dataset,
    udf_function_name
  );

  ASSERT NOT REGEXP_CONTAINS(rendered_sql, r'__[A-Z0-9_]+__')
  AS 'Unresolved placeholder in current_target_tables SQL.';

  EXECUTE IMMEDIATE rendered_sql;

  SET sql_template = """
    CREATE OR REPLACE TEMP TABLE current_target_columns AS
    SELECT *
    FROM `__TARGET__.INFORMATION_SCHEMA.COLUMNS`
  """;

  SET rendered_sql = render_dynamic_sql(
    sql_template,
    repository_project_id,
    repository_dataset,
    target_project_id,
    target_dataset,
    job_region,
    udf_project_id,
    udf_dataset,
    udf_function_name
  );

  ASSERT NOT REGEXP_CONTAINS(rendered_sql, r'__[A-Z0-9_]+__')
  AS 'Unresolved placeholder in current_target_columns SQL.';

  EXECUTE IMMEDIATE rendered_sql;

  SET sql_template = """
    CREATE OR REPLACE TEMP TABLE current_target_column_field_paths AS
    SELECT *
    FROM `__TARGET__.INFORMATION_SCHEMA.COLUMN_FIELD_PATHS`
  """;

  SET rendered_sql = render_dynamic_sql(
    sql_template,
    repository_project_id,
    repository_dataset,
    target_project_id,
    target_dataset,
    job_region,
    udf_project_id,
    udf_dataset,
    udf_function_name
  );

  ASSERT NOT REGEXP_CONTAINS(rendered_sql, r'__[A-Z0-9_]+__')
  AS 'Unresolved placeholder in current_target_column_field_paths SQL.';

  EXECUTE IMMEDIATE rendered_sql;

  SET sql_template = """
      MERGE
        `__REPOSITORY__.lineage_definition_registry` AS target
      USING current_view_definitions AS source
      ON LOWER(target.object_project) = source.object_project
      AND LOWER(target.object_dataset) = source.object_dataset
      AND LOWER(target.object_name) = source.object_name
      AND target.object_type = source.object_type
      WHEN MATCHED THEN
        UPDATE SET
          target.generation_type = source.generation_type,
          target.definition_source = source.definition_source,
          target.definition_text = source.definition_text,
          target.previous_definition_hash = CASE
            WHEN target.definition_hash IS DISTINCT FROM source.definition_hash
              THEN target.definition_hash
            ELSE target.previous_definition_hash
          END,
          target.definition_hash = source.definition_hash,
          target.source_job_id = NULL,
          target.source_job_time = NULL,
          target.source_user_email = NULL,
          target.is_changed = (
            target.is_changed
            OR target.definition_hash IS DISTINCT FROM source.definition_hash
          ),
          target.is_active = TRUE,
          target.analysis_status = CASE
            WHEN target.definition_hash IS DISTINCT FROM source.definition_hash
              THEN NULL
            ELSE target.analysis_status
          END,
          target.last_seen_at = CURRENT_TIMESTAMP(),
          target.updated_at = CURRENT_TIMESTAMP()
      WHEN NOT MATCHED THEN
        INSERT (
          object_project,
          object_dataset,
          object_name,
          object_type,
          generation_type,
          definition_source,
          definition_text,
          definition_hash,
          previous_definition_hash,
          source_job_id,
          source_job_time,
          source_user_email,
          is_changed,
          is_active,
          analysis_status,
          last_analyzed_hash,
          first_seen_at,
          last_seen_at,
          last_analyzed_at,
          updated_at
        )
        VALUES (
          source.object_project,
          source.object_dataset,
          source.object_name,
          source.object_type,
          source.generation_type,
          source.definition_source,
          source.definition_text,
          source.definition_hash,
          NULL,
          NULL,
          NULL,
          NULL,
          TRUE,
          TRUE,
          NULL,
          NULL,
          CURRENT_TIMESTAMP(),
          CURRENT_TIMESTAMP(),
          NULL,
          CURRENT_TIMESTAMP()
        );
  """;

  SET rendered_sql = render_dynamic_sql(
    sql_template,
    repository_project_id,
    repository_dataset,
    target_project_id,
    target_dataset,
    job_region,
    udf_project_id,
    udf_dataset,
    udf_function_name
  );

  ASSERT NOT REGEXP_CONTAINS(rendered_sql, r'__[A-Z0-9_]+__')
  AS 'Unresolved placeholder in lineage_definition_registry MERGE SQL.';

  EXECUTE IMMEDIATE rendered_sql;

  UPDATE
    `lineage_definition_registry` AS registry
  SET
    is_active = FALSE,
    is_changed = FALSE,
    analysis_status = 'INACTIVE_OBJECT_NOT_FOUND',
    updated_at = CURRENT_TIMESTAMP()
  WHERE registry.object_type = 'VIEW'
    AND registry.generation_type = 'VIEW_DEFINITION'
    AND registry.is_active = TRUE
    AND LOWER(registry.object_project) = LOWER(target_project_id)
    AND LOWER(registry.object_dataset) = LOWER(target_dataset)
    AND NOT EXISTS (
      SELECT 1
      FROM current_view_definitions AS source
      WHERE source.object_project = LOWER(registry.object_project)
        AND source.object_dataset = LOWER(registry.object_dataset)
        AND source.object_name = LOWER(registry.object_name)
    );

  SELECT
    'SYNC_VIEW_REGISTRY' AS step_name,
    step_started_at,
    CURRENT_TIMESTAMP() AS step_finished_at,
    (SELECT COUNT(*) FROM current_view_definitions)
      AS current_view_count;
END;

-- ============================================================================
-- STEP 2: Synchronize Scheduled Query / DAG generated-table definitions
-- ============================================================================
BEGIN
  DECLARE step_started_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP();
  DECLARE initial_lookback_days INT64 DEFAULT 60;
  DECLARE incremental_lookback_days INT64 DEFAULT 3;
  DECLARE lookback_days INT64;

  DECLARE scheduled_query_service_accounts ARRAY<STRING>;
  DECLARE dag_service_accounts ARRAY<STRING>;

  SET scheduled_query_service_accounts = COALESCE((
    SELECT service_accounts
    FROM
      `lineage_execution_account_config`
    WHERE execution_source = 'SCHEDULED_QUERY'
      AND is_active = TRUE
  ), ARRAY<STRING>[]);

  SET dag_service_accounts = COALESCE((
    SELECT service_accounts
    FROM
      `lineage_execution_account_config`
    WHERE execution_source = 'DAG'
      AND is_active = TRUE
  ), ARRAY<STRING>[]);

  ASSERT ARRAY_LENGTH(scheduled_query_service_accounts) > 0
  AS 'No active Scheduled Query service accounts are configured.';

  ASSERT ARRAY_LENGTH(dag_service_accounts) > 0
  AS 'No active DAG service accounts are configured.';

  CREATE TABLE IF NOT EXISTS
    `lineage_job_registry`
  (
    job_project STRING NOT NULL,
    job_id STRING NOT NULL,
    creation_time TIMESTAMP NOT NULL,
    start_time TIMESTAMP,
    end_time TIMESTAMP,
    execution_source STRING NOT NULL,
    source_detection_method STRING NOT NULL,
    user_email STRING,
    labels ARRAY<STRUCT<key STRING, value STRING>>,
    statement_type STRING,
    query_text STRING,
    definition_text STRING,
    definition_hash STRING NOT NULL,
    destination_project STRING NOT NULL,
    destination_dataset STRING NOT NULL,
    destination_table STRING NOT NULL,
    collected_at TIMESTAMP NOT NULL,
    updated_at TIMESTAMP NOT NULL
  )
  PARTITION BY DATE(creation_time)
  CLUSTER BY
    destination_project,
    destination_dataset,
    destination_table,
    execution_source;

  SET lookback_days = IF(
    (
      SELECT COUNT(*)
      FROM `lineage_job_registry`
    ) = 0,
    initial_lookback_days,
    incremental_lookback_days
  );

  SET sql_template = """
    CREATE OR REPLACE TEMP TABLE raw_generated_table_jobs AS
    SELECT
      project_id,
      job_id,
      creation_time,
      start_time,
      end_time,
      user_email,
      labels,
      statement_type,
      query,
      destination_table
    FROM `__TARGET_PROJECT__.region-__JOB_REGION__`.INFORMATION_SCHEMA.JOBS_BY_PROJECT
    WHERE creation_time >= TIMESTAMP_SUB(
      CURRENT_TIMESTAMP(),
      INTERVAL @lookback_days DAY
    )
      AND creation_time < CURRENT_TIMESTAMP()
      AND job_type = 'QUERY'
      AND state = 'DONE'
      AND error_result IS NULL
      AND query IS NOT NULL
      AND destination_table IS NOT NULL
      AND statement_type IN (
        'SELECT',
        'CREATE_TABLE_AS_SELECT'
      )
  """;

  SET rendered_sql = render_dynamic_sql(
    sql_template,
    repository_project_id,
    repository_dataset,
    target_project_id,
    target_dataset,
    job_region,
    udf_project_id,
    udf_dataset,
    udf_function_name
  );

  ASSERT NOT REGEXP_CONTAINS(rendered_sql, r'__[A-Z0-9_]+__')
  AS 'Unresolved placeholder in raw_generated_table_jobs SQL.';

  EXECUTE IMMEDIATE rendered_sql
  USING lookback_days AS lookback_days;

  CREATE OR REPLACE TEMP TABLE recent_generated_table_jobs AS
  WITH target_jobs AS (
    SELECT
      project_id AS job_project,
      job_id,
      creation_time,
      start_time,
      end_time,
      user_email,
      labels,
      statement_type,
      query,
      destination_table.project_id AS destination_project,
      destination_table.dataset_id AS destination_dataset,
      destination_table.table_id AS destination_table,
      (
        EXISTS (
          SELECT 1
          FROM UNNEST(labels) AS label
          WHERE label.key = 'data_source_id'
            AND label.value = 'scheduled_query'
        )
        AND user_email IN UNNEST(
          scheduled_query_service_accounts
        )
      ) AS is_scheduled_query,
      user_email IN UNNEST(dag_service_accounts) AS is_dag
    FROM raw_generated_table_jobs
  ),
  classified_jobs AS (
    SELECT
      job_project,
      job_id,
      creation_time,
      start_time,
      end_time,
      CASE
        WHEN is_scheduled_query THEN 'SCHEDULED_QUERY'
        WHEN is_dag THEN 'DAG'
      END AS execution_source,
      CASE
        WHEN is_scheduled_query THEN 'LABEL_AND_ACCOUNT'
        WHEN is_dag THEN 'USER_EMAIL'
      END AS source_detection_method,
      user_email,
      labels,
      statement_type,
      query AS query_text,
      LOWER(destination_project) AS destination_project,
      LOWER(destination_dataset) AS destination_dataset,
      LOWER(destination_table) AS destination_table
    FROM target_jobs
    WHERE is_scheduled_query
       OR is_dag
  ),
  normalized_definitions AS (
    SELECT
      *,
      CASE
        WHEN statement_type = 'CREATE_TABLE_AS_SELECT'
          THEN REGEXP_REPLACE(
            query_text,
            r'(?is)^\s*CREATE\s+(?:OR\s+REPLACE\s+)?TABLE\s+'
            r'(?:IF\s+NOT\s+EXISTS\s+)?(?:`[^`]+`|[^\s]+)'
            r'(?:\s+OPTIONS\s*\([^;]*?\))?\s+AS\s+',
            ''
          )
        ELSE query_text
      END AS definition_text
    FROM classified_jobs
  )
  SELECT
    job_project,
    job_id,
    creation_time,
    start_time,
    end_time,
    execution_source,
    source_detection_method,
    user_email,
    labels,
    statement_type,
    query_text,
    definition_text,
    TO_HEX(SHA256(definition_text)) AS definition_hash,
    destination_project,
    destination_dataset,
    destination_table,
    CURRENT_TIMESTAMP() AS collected_at,
    CURRENT_TIMESTAMP() AS updated_at
  FROM normalized_definitions
  WHERE definition_text IS NOT NULL
    AND TRIM(definition_text) != '';

  SET sql_template = """
      MERGE
        `__REPOSITORY__.lineage_job_registry` AS target
      USING recent_generated_table_jobs AS source
      ON target.job_project = source.job_project
      AND target.job_id = source.job_id
      WHEN MATCHED THEN
        UPDATE SET
          target.creation_time = source.creation_time,
          target.start_time = source.start_time,
          target.end_time = source.end_time,
          target.execution_source = source.execution_source,
          target.source_detection_method = source.source_detection_method,
          target.user_email = source.user_email,
          target.labels = source.labels,
          target.statement_type = source.statement_type,
          target.query_text = source.query_text,
          target.definition_text = source.definition_text,
          target.definition_hash = source.definition_hash,
          target.destination_project = source.destination_project,
          target.destination_dataset = source.destination_dataset,
          target.destination_table = source.destination_table,
          target.collected_at = source.collected_at,
          target.updated_at = source.updated_at
      WHEN NOT MATCHED THEN
        INSERT (
          job_project,
          job_id,
          creation_time,
          start_time,
          end_time,
          execution_source,
          source_detection_method,
          user_email,
          labels,
          statement_type,
          query_text,
          definition_text,
          definition_hash,
          destination_project,
          destination_dataset,
          destination_table,
          collected_at,
          updated_at
        )
        VALUES (
          source.job_project,
          source.job_id,
          source.creation_time,
          source.start_time,
          source.end_time,
          source.execution_source,
          source.source_detection_method,
          source.user_email,
          source.labels,
          source.statement_type,
          source.query_text,
          source.definition_text,
          source.definition_hash,
          source.destination_project,
          source.destination_dataset,
          source.destination_table,
          source.collected_at,
          source.updated_at
        );
  """;

  SET rendered_sql = render_dynamic_sql(
    sql_template,
    repository_project_id,
    repository_dataset,
    target_project_id,
    target_dataset,
    job_region,
    udf_project_id,
    udf_dataset,
    udf_function_name
  );

  ASSERT NOT REGEXP_CONTAINS(rendered_sql, r'__[A-Z0-9_]+__')
  AS 'Unresolved placeholder in lineage_job_registry MERGE SQL.';

  EXECUTE IMMEDIATE rendered_sql;

  CREATE OR REPLACE TEMP TABLE latest_generated_table_definitions AS
  SELECT
    destination_project AS object_project,
    destination_dataset AS object_dataset,
    destination_table AS object_name,
    'TABLE' AS object_type,
    execution_source AS generation_type,
    'INFORMATION_SCHEMA.JOBS' AS definition_source,
    definition_text,
    definition_hash,
    job_id AS source_job_id,
    creation_time AS source_job_time,
    user_email AS source_user_email
  FROM `lineage_job_registry`
  QUALIFY ROW_NUMBER() OVER (
    PARTITION BY
      destination_project,
      destination_dataset,
      destination_table
    ORDER BY
      creation_time DESC,
      job_id DESC
  ) = 1;

  SET sql_template = """
      MERGE
        `__REPOSITORY__.lineage_definition_registry` AS target
      USING latest_generated_table_definitions AS source
      ON LOWER(target.object_project) = source.object_project
      AND LOWER(target.object_dataset) = source.object_dataset
      AND LOWER(target.object_name) = source.object_name
      AND target.object_type = source.object_type
      WHEN MATCHED THEN
        UPDATE SET
          target.generation_type = source.generation_type,
          target.definition_source = source.definition_source,
          target.definition_text = source.definition_text,
          target.previous_definition_hash = CASE
            WHEN target.definition_hash IS DISTINCT FROM source.definition_hash
              THEN target.definition_hash
            ELSE target.previous_definition_hash
          END,
          target.definition_hash = source.definition_hash,
          target.source_job_id = source.source_job_id,
          target.source_job_time = source.source_job_time,
          target.source_user_email = source.source_user_email,
          target.is_changed = (
            target.is_changed
            OR target.definition_hash IS DISTINCT FROM source.definition_hash
          ),
          target.is_active = TRUE,
          target.analysis_status = CASE
            WHEN target.definition_hash IS DISTINCT FROM source.definition_hash
              THEN NULL
            ELSE target.analysis_status
          END,
          target.last_seen_at = CURRENT_TIMESTAMP(),
          target.updated_at = CURRENT_TIMESTAMP()
      WHEN NOT MATCHED THEN
        INSERT (
          object_project,
          object_dataset,
          object_name,
          object_type,
          generation_type,
          definition_source,
          definition_text,
          definition_hash,
          previous_definition_hash,
          source_job_id,
          source_job_time,
          source_user_email,
          is_changed,
          is_active,
          analysis_status,
          last_analyzed_hash,
          first_seen_at,
          last_seen_at,
          last_analyzed_at,
          updated_at
        )
        VALUES (
          source.object_project,
          source.object_dataset,
          source.object_name,
          source.object_type,
          source.generation_type,
          source.definition_source,
          source.definition_text,
          source.definition_hash,
          NULL,
          source.source_job_id,
          source.source_job_time,
          source.source_user_email,
          TRUE,
          TRUE,
          NULL,
          NULL,
          CURRENT_TIMESTAMP(),
          CURRENT_TIMESTAMP(),
          NULL,
          CURRENT_TIMESTAMP()
        );
  """;

  SET rendered_sql = render_dynamic_sql(
    sql_template,
    repository_project_id,
    repository_dataset,
    target_project_id,
    target_dataset,
    job_region,
    udf_project_id,
    udf_dataset,
    udf_function_name
  );

  ASSERT NOT REGEXP_CONTAINS(rendered_sql, r'__[A-Z0-9_]+__')
  AS 'Unresolved placeholder in lineage_definition_registry MERGE SQL.';

  EXECUTE IMMEDIATE rendered_sql;

  UPDATE
    `lineage_definition_registry` AS registry
  SET
    is_active = FALSE,
    is_changed = FALSE,
    analysis_status = 'INACTIVE_OBJECT_NOT_FOUND',
    updated_at = CURRENT_TIMESTAMP()
  WHERE registry.object_type = 'TABLE'
    AND registry.generation_type IN (
      'SCHEDULED_QUERY',
      'DAG'
    )
    AND registry.is_active = TRUE
    AND LOWER(registry.object_project) = LOWER(target_project_id)
    AND NOT EXISTS (
      SELECT 1
      FROM current_target_tables AS table_info
      WHERE LOWER(table_info.table_catalog) =
        LOWER(registry.object_project)
        AND LOWER(table_info.table_schema) =
          LOWER(registry.object_dataset)
        AND LOWER(table_info.table_name) =
          LOWER(registry.object_name)
    );

  SELECT
    'SYNC_GENERATED_TABLE_REGISTRY' AS step_name,
    step_started_at,
    CURRENT_TIMESTAMP() AS step_finished_at,
    lookback_days,
    (SELECT COUNT(*) FROM recent_generated_table_jobs)
      AS recent_target_job_count;
END;

-- ============================================================================
-- Non-completed UDF results retained for the final operational result set.
-- COMPLETED is the only normal status during the stabilization period.
-- ============================================================================
CREATE TEMP TABLE non_completed_udf_results (
  object_project STRING,
  object_dataset STRING,
  object_name STRING,
  object_type STRING,
  analysis_status STRING,
  diagnostic_count INT64,
  output_lineage_count INT64,
  lineage_path_count INT64,
  diagnostic_code STRING,
  engine_stage STRING,
  severity STRING,
  message STRING,
  diagnostic_json JSON,
  error_nodes_json JSON,
  analysis_result_json STRING
);

-- ============================================================================
-- STEP 3: Analyze changed definitions
-- ============================================================================
BEGIN
  -- ============================================================================
  -- 06_analyze_changed_objects.sql
  -- EXECUTION ORDER: Initial setup 08 / Daily operation 03
  -- ============================================================================
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
  -- Environment-dependent scalar values are declared at the top of this file.
  -- Execution account arrays are loaded from lineage_execution_account_config.
  -- ============================================================================

  DECLARE run_started_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP();
  DECLARE strict_mode BOOL DEFAULT parser_strict_mode;
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
      FROM current_target_columns
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
      FROM current_target_column_field_paths AS field
      LEFT JOIN current_target_columns AS column_info
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
    `lineage_direct_dependency` AS dependency
  WHERE NOT EXISTS (
    SELECT 1
    FROM
      `lineage_definition_registry` AS registry
    WHERE registry.is_active = TRUE
      AND LOWER(registry.object_project) = LOWER(dependency.target_project)
      AND LOWER(registry.object_dataset) = LOWER(dependency.target_dataset)
      AND LOWER(registry.object_name) = LOWER(dependency.target_object)
      AND registry.object_type = dependency.target_object_type
      AND registry.generation_type = dependency.generation_type
  );

  DELETE FROM
    `lineage_diagnostic` AS diagnostic
  WHERE NOT EXISTS (
    SELECT 1
    FROM
      `lineage_definition_registry` AS registry
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
      `lineage_definition_registry`
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
      -- Variables declared in this outer block remain visible to the inner
      -- EXCEPTION handler. BigQuery does not expose variables declared in the
      -- same BEGIN block to that block's EXCEPTION section.
      DECLARE analysis_id STRING DEFAULT GENERATE_UUID();
      DECLARE analyzed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP();
      DECLARE exported_json STRING;
      DECLARE udf_analysis_status STRING;
      DECLARE replacement_started BOOL DEFAULT FALSE;

      BEGIN
        SET sql_template = """
        SELECT `__UDF__`(
          @definition_text,
          @physical_columns_json,
          @options_json,
          @context_json
        )
      """;

      SET rendered_sql = render_dynamic_sql(
        sql_template,
        repository_project_id,
        repository_dataset,
        target_project_id,
        target_dataset,
        job_region,
        udf_project_id,
        udf_dataset,
        udf_function_name
      );

      ASSERT NOT REGEXP_CONTAINS(rendered_sql, r'__[A-Z0-9_]+__')
      AS 'Unresolved placeholder in lineage UDF SQL.';

      EXECUTE IMMEDIATE rendered_sql
      INTO exported_json
      USING
        target.definition_text AS definition_text,
        physical_columns_json AS physical_columns_json,
        TO_JSON_STRING(STRUCT(
          strict_mode AS strict_mode,
          TRUE AS compact_export
        )) AS options_json,
        TO_JSON_STRING(STRUCT(
          analysis_id AS analysis_id,
          target.object_project AS view_project,
          target.object_dataset AS view_dataset,
          target.object_name AS view_name,
          FORMAT_TIMESTAMP(
            '%FT%H:%M:%E*S%Ez',
            analyzed_at
          ) AS analyzed_at
        )) AS context_json;

      SET udf_analysis_status = COALESCE(
        JSON_VALUE(exported_json, '$.analysis.analysis_status'),
        'UNKNOWN'
      );

      -- ----------------------------------------------------------------------
      -- Always stage UDF diagnostics before deciding whether the result can be
      -- published. This preserves the original parser/resolver diagnostics for
      -- PARTIAL_FAILURE and other non-publishable statuses.
      -- ----------------------------------------------------------------------
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
        COALESCE(
          JSON_QUERY_ARRAY(
            exported_json,
            '$.exported_tables.diagnostics'
          ),
          CAST([] AS ARRAY<STRING>)
        )
      ) AS diagnostic_row;

      IF udf_analysis_status = 'COMPLETED' THEN
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
          `lineage_definition_registry`
            AS source_registry
          ON source_registry.is_active = TRUE
         AND LOWER(source_registry.object_project) = parsed.source_project
         AND LOWER(source_registry.object_dataset) = parsed.source_dataset
         AND LOWER(source_registry.object_name) = parsed.source_object
         AND source_registry.object_type = 'VIEW'
        LEFT JOIN
          current_target_tables AS source_table
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


      CREATE OR REPLACE TEMP TABLE previous_direct_dependency AS
      SELECT *
      FROM
        `lineage_direct_dependency`
      WHERE LOWER(target_project) = LOWER(target.object_project)
        AND LOWER(target_dataset) = LOWER(target.object_dataset)
        AND LOWER(target_object) = LOWER(target.object_name)
        AND target_object_type = target.object_type
        AND generation_type = target.generation_type;

      CREATE OR REPLACE TEMP TABLE previous_lineage_diagnostic AS
      SELECT *
      FROM
        `lineage_diagnostic`
      WHERE LOWER(object_project) = LOWER(target.object_project)
        AND LOWER(object_dataset) = LOWER(target.object_dataset)
        AND LOWER(object_name) = LOWER(target.object_name)
        AND object_type = target.object_type;

      SET replacement_started = TRUE;

      DELETE FROM
        `lineage_direct_dependency`
      WHERE LOWER(target_project) = LOWER(target.object_project)
        AND LOWER(target_dataset) = LOWER(target.object_dataset)
        AND LOWER(target_object) = LOWER(target.object_name)
        AND target_object_type = target.object_type
        AND generation_type = target.generation_type;

      INSERT INTO
        `lineage_direct_dependency`
      SELECT *
      FROM staged_direct_dependency;

      DELETE FROM
        `lineage_diagnostic`
      WHERE LOWER(object_project) = LOWER(target.object_project)
        AND LOWER(object_dataset) = LOWER(target.object_dataset)
        AND LOWER(object_name) = LOWER(target.object_name)
        AND object_type = target.object_type;

      INSERT INTO
        `lineage_diagnostic`
      SELECT *
      FROM staged_lineage_diagnostic;

      UPDATE
        `lineage_definition_registry`
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
      ELSE
        -- Do not replace the last known-good dependency rows when the UDF
        -- reports PARTIAL_FAILURE or another non-publishable status.
        -- Replace only the diagnostics so the actual parser/resolver reason is
        -- available in lineage_diagnostic for troubleshooting.
        DELETE FROM
          `lineage_diagnostic`
        WHERE LOWER(object_project) = LOWER(target.object_project)
          AND LOWER(object_dataset) = LOWER(target.object_dataset)
          AND LOWER(object_name) = LOWER(target.object_name)
          AND object_type = target.object_type;

        INSERT INTO
          `lineage_diagnostic`
        SELECT *
        FROM staged_lineage_diagnostic;

        INSERT INTO
          `lineage_diagnostic`
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
          'UDF_RESULT_NOT_PUBLISHABLE',
          '06_analyze_changed_objects',
          'ERROR',
          NULL,
          NULL,
          FORMAT(
            'Lineage UDF returned a non-publishable status: %s',
            udf_analysis_status
          ),
          JSON_OBJECT(
            'udf_analysis_status', udf_analysis_status,
            'analysis_message', JSON_VALUE(
              exported_json,
              '$.analysis.message'
            )
          ),
          analyzed_at
        );

        UPDATE
          `lineage_definition_registry`
        SET
          is_changed = TRUE,
          analysis_status = 'FAILED',
          last_analyzed_at = analyzed_at,
          updated_at = analyzed_at
        WHERE LOWER(object_project) = LOWER(target.object_project)
          AND LOWER(object_dataset) = LOWER(target.object_dataset)
          AND LOWER(object_name) = LOWER(target.object_name)
          AND object_type = target.object_type
          AND generation_type = target.generation_type
          AND definition_hash = target.definition_hash;

        -- Keep every non-COMPLETED UDF result for the final result set.
        -- When the UDF returned no diagnostic row, insert a summary-only row so
        -- the status and complete JSON result are still visible.
        INSERT INTO non_completed_udf_results
        SELECT
          LOWER(target.object_project),
          LOWER(target.object_dataset),
          LOWER(target.object_name),
          target.object_type,
          udf_analysis_status,
          ARRAY_LENGTH(COALESCE(
            JSON_QUERY_ARRAY(exported_json, '$.exported_tables.diagnostics'),
            CAST([] AS ARRAY<STRING>)
          )),
          ARRAY_LENGTH(COALESCE(
            JSON_QUERY_ARRAY(exported_json, '$.exported_tables.output_lineages'),
            CAST([] AS ARRAY<STRING>)
          )),
          ARRAY_LENGTH(COALESCE(
            JSON_QUERY_ARRAY(exported_json, '$.exported_tables.lineage_paths'),
            CAST([] AS ARRAY<STRING>)
          )),
          diagnostic_code,
          engine_stage,
          severity,
          message,
          diagnostic_json,
          SAFE.PARSE_JSON(JSON_VALUE(
            exported_json,
            '$.analysis.error_nodes_json'
          )),
          exported_json
        FROM staged_lineage_diagnostic;

        IF (SELECT COUNT(*) FROM staged_lineage_diagnostic) = 0 THEN
          INSERT INTO non_completed_udf_results VALUES (
            LOWER(target.object_project),
            LOWER(target.object_dataset),
            LOWER(target.object_name),
            target.object_type,
            udf_analysis_status,
            0,
            ARRAY_LENGTH(COALESCE(
              JSON_QUERY_ARRAY(exported_json, '$.exported_tables.output_lineages'),
              CAST([] AS ARRAY<STRING>)
            )),
            ARRAY_LENGTH(COALESCE(
              JSON_QUERY_ARRAY(exported_json, '$.exported_tables.lineage_paths'),
              CAST([] AS ARRAY<STRING>)
            )),
            NULL,
            NULL,
            NULL,
            JSON_VALUE(exported_json, '$.analysis.message'),
            NULL,
            SAFE.PARSE_JSON(JSON_VALUE(
              exported_json,
              '$.analysis.error_nodes_json'
            )),
            exported_json
          );
        END IF;

        SET failed_object_count = failed_object_count + 1;
      END IF;

      EXCEPTION WHEN ERROR THEN
        IF replacement_started THEN
        DELETE FROM
          `lineage_direct_dependency`
        WHERE LOWER(target_project) = LOWER(target.object_project)
          AND LOWER(target_dataset) = LOWER(target.object_dataset)
          AND LOWER(target_object) = LOWER(target.object_name)
          AND target_object_type = target.object_type
          AND generation_type = target.generation_type;

        INSERT INTO
          `lineage_direct_dependency`
        SELECT *
        FROM previous_direct_dependency;

        DELETE FROM
          `lineage_diagnostic`
        WHERE LOWER(object_project) = LOWER(target.object_project)
          AND LOWER(object_dataset) = LOWER(target.object_dataset)
          AND LOWER(object_name) = LOWER(target.object_name)
          AND object_type = target.object_type;

        INSERT INTO
          `lineage_diagnostic`
        SELECT *
        FROM previous_lineage_diagnostic;
      END IF;

      UPDATE
        `lineage_definition_registry`
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
        `lineage_diagnostic`
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

      INSERT INTO non_completed_udf_results VALUES (
        LOWER(target.object_project),
        LOWER(target.object_dataset),
        LOWER(target.object_name),
        target.object_type,
        'EXECUTION_FAILED',
        1,
        NULL,
        NULL,
        'ANALYSIS_EXECUTION_FAILED',
        '06_analyze_changed_objects',
        'ERROR',
        @@error.message,
        JSON_OBJECT(
          'statement_text', @@error.statement_text,
          'formatted_stack_trace', @@error.formatted_stack_trace
        ),
        JSON_ARRAY(JSON_OBJECT(
          'severity', 'ERROR',
          'diagnostic_code', 'ANALYSIS_EXECUTION_FAILED',
          'message', @@error.message,
          'original_sql', target.definition_text
        )),
        exported_json
      );

        SET failed_object_count = failed_object_count + 1;
      END;
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
        `lineage_definition_registry`
      WHERE is_active = TRUE
        AND is_changed = TRUE
    ) AS remaining_changed_object_count,
    (
      SELECT COUNT(*)
      FROM
        `lineage_direct_dependency`
    ) AS direct_dependency_count,
    (
      SELECT COUNT(*)
      FROM
        `lineage_diagnostic`
      WHERE severity = 'ERROR'
    ) AS error_diagnostic_count;
END;

-- ============================================================================
-- STEP 4: Rebuild ranked impact paths
-- ============================================================================
BEGIN
  DECLARE snapshot_time TIMESTAMP DEFAULT CURRENT_TIMESTAMP();
  DECLARE max_rank INT64 DEFAULT configured_max_impact_rank;

  CREATE OR REPLACE TABLE
    `lineage_impact`
  PARTITION BY DATE(snapshot_at)
  CLUSTER BY
    origin_project,
    origin_dataset,
    origin_object,
    origin_column
  AS
  WITH RECURSIVE impact_tree AS (
    SELECT
      LOWER(edge.source_project) AS origin_project,
      LOWER(edge.source_dataset) AS origin_dataset,
      LOWER(edge.source_object) AS origin_object,
      edge.source_object_type AS origin_object_type,
      LOWER(edge.source_column) AS origin_column,
      1 AS impact_rank,
      LOWER(edge.target_project) AS impacted_project,
      LOWER(edge.target_dataset) AS impacted_dataset,
      LOWER(edge.target_object) AS impacted_object,
      edge.target_object_type AS impacted_object_type,
      LOWER(edge.target_column) AS impacted_column,
      LOWER(edge.source_project) AS direct_source_project,
      LOWER(edge.source_dataset) AS direct_source_dataset,
      LOWER(edge.source_object) AS direct_source_object,
      edge.source_object_type AS direct_source_object_type,
      LOWER(edge.source_column) AS direct_source_column,
      [
        CONCAT(
          COALESCE(LOWER(edge.source_project), ''), '.',
          COALESCE(LOWER(edge.source_dataset), ''), '.',
          LOWER(edge.source_object), '.',
          COALESCE(LOWER(edge.source_column), '*')
        ),
        CONCAT(
          COALESCE(LOWER(edge.target_project), ''), '.',
          COALESCE(LOWER(edge.target_dataset), ''), '.',
          LOWER(edge.target_object), '.',
          COALESCE(LOWER(edge.target_column), '*')
        )
      ] AS dependency_path,
      edge.generation_type,
      edge.resolution_status,
      FALSE AS is_cycle
    FROM
      `lineage_direct_dependency` AS edge
    WHERE edge.resolution_status IN (
      'RESOLVED',
      'SOURCE_RESOLVED',
      'PARTIALLY_RESOLVED'
    )

    UNION ALL

    SELECT
      parent.origin_project,
      parent.origin_dataset,
      parent.origin_object,
      parent.origin_object_type,
      parent.origin_column,
      parent.impact_rank + 1,
      LOWER(child.target_project),
      LOWER(child.target_dataset),
      LOWER(child.target_object),
      child.target_object_type,
      LOWER(child.target_column),
      LOWER(child.source_project),
      LOWER(child.source_dataset),
      LOWER(child.source_object),
      child.source_object_type,
      LOWER(child.source_column),
      ARRAY_CONCAT(
        parent.dependency_path,
        [CONCAT(
          COALESCE(LOWER(child.target_project), ''), '.',
          COALESCE(LOWER(child.target_dataset), ''), '.',
          LOWER(child.target_object), '.',
          COALESCE(LOWER(child.target_column), '*')
        )]
      ),
      child.generation_type,
      child.resolution_status,
      CONCAT(
        COALESCE(LOWER(child.target_project), ''), '.',
        COALESCE(LOWER(child.target_dataset), ''), '.',
        LOWER(child.target_object), '.',
        COALESCE(LOWER(child.target_column), '*')
      ) IN UNNEST(parent.dependency_path) AS is_cycle
    FROM impact_tree AS parent
    JOIN
      `lineage_direct_dependency` AS child
      ON LOWER(child.source_project) =
        LOWER(parent.impacted_project)
     AND LOWER(child.source_dataset) =
        LOWER(parent.impacted_dataset)
     AND LOWER(child.source_object) =
        LOWER(parent.impacted_object)
     AND (
       LOWER(child.source_column) =
         LOWER(parent.impacted_column)
       OR child.source_column IS NULL
       OR parent.impacted_column IS NULL
     )
    WHERE parent.impact_rank < max_rank
      AND parent.is_cycle = FALSE
      AND child.resolution_status IN (
        'RESOLVED',
        'SOURCE_RESOLVED',
        'PARTIALLY_RESOLVED'
      )
  )
  SELECT DISTINCT
    snapshot_time AS snapshot_at,
    origin_project,
    origin_dataset,
    origin_object,
    origin_object_type,
    origin_column,
    impact_rank,
    impacted_project,
    impacted_dataset,
    impacted_object,
    impacted_object_type,
    impacted_column,
    direct_source_project,
    direct_source_dataset,
    direct_source_object,
    direct_source_object_type,
    direct_source_column,
    dependency_path,
    TO_HEX(
      SHA256(ARRAY_TO_STRING(dependency_path, ' -> '))
    ) AS path_hash,
    generation_type,
    resolution_status,
    is_cycle
  FROM impact_tree;

  SELECT
    'REBUILD_IMPACT' AS step_name,
    snapshot_time AS step_started_at,
    CURRENT_TIMESTAMP() AS step_finished_at,
    (
      SELECT COUNT(*)
      FROM `lineage_impact`
    ) AS impact_row_count;
END;

-- ============================================================================
-- PIPELINE SUMMARY
-- ============================================================================
SELECT
  CURRENT_TIMESTAMP() AS pipeline_finished_at,
  (
    SELECT COUNT(*)
    FROM `lineage_definition_registry`
    WHERE is_active = TRUE
  ) AS active_definition_count,
  (
    SELECT COUNT(*)
    FROM `lineage_definition_registry`
    WHERE is_active = TRUE
      AND is_changed = TRUE
  ) AS remaining_changed_definition_count,
  (
    SELECT COUNT(*)
    FROM `lineage_direct_dependency`
  ) AS direct_dependency_count,
  (
    SELECT COUNT(*)
    FROM `lineage_impact`
  ) AS impact_count,
  (
    SELECT COUNT(*)
    FROM `lineage_diagnostic`
    WHERE severity = 'ERROR'
  ) AS error_diagnostic_count;
END;


-- ============================================================================
-- FINAL OPERATIONAL RESULT
-- COMPLETED is intentionally excluded. During stabilization, every warning,
-- partial resolution, failure, unknown status, and execution exception is shown.
-- ============================================================================
SELECT
  object_project,
  object_dataset,
  object_name,
  object_type,
  analysis_status,
  diagnostic_count,
  output_lineage_count,
  lineage_path_count,
  diagnostic_code,
  engine_stage,
  severity,
  message,
  diagnostic_json,
  error_nodes_json,
  analysis_result_json
FROM non_completed_udf_results
ORDER BY
  object_project,
  object_dataset,
  object_name,
  severity DESC,
  diagnostic_code;
