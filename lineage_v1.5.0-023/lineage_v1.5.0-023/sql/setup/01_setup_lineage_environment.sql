-- ============================================================================
-- 01_setup_lineage_environment.sql
-- BigQuery Physical Lineage Repository - Environment setup
-- ============================================================================
SET @@location = 'asia-northeast1';

-- ============================================================================
-- Bootstrap values
--
-- Only this section must be edited when installing the repository in another
-- environment. After lineage_config is created, all remaining setup logic
-- reads the typed configuration row with SELECT AS STRUCT.
--
-- Prerequisite:
--   Upload lineage_udf_bundle.js to the configured GCS URI before execution.
-- ============================================================================
DECLARE bootstrap_repository_project_id STRING DEFAULT 'audeodb';
DECLARE bootstrap_repository_dataset STRING DEFAULT 'lineage_repository';
DECLARE bootstrap_repository_location STRING DEFAULT 'asia-northeast1';

DECLARE bootstrap_udf_project_id STRING DEFAULT 'audeodb';
DECLARE bootstrap_udf_dataset STRING DEFAULT 'sample_ds';
DECLARE bootstrap_udf_function_name STRING DEFAULT 'analyze_lineage_json';
DECLARE bootstrap_udf_library_uri STRING DEFAULT
  'gs://YOUR_BUCKET/YOUR_PATH/lineage_udf_bundle.js';

DECLARE bootstrap_target_project_id STRING DEFAULT 'audeodb';
DECLARE bootstrap_target_region STRING DEFAULT 'asia-northeast1';
DECLARE bootstrap_target_datasets ARRAY<STRING> DEFAULT ['sample_ds'];

DECLARE bootstrap_initial_job_lookback_days INT64 DEFAULT 60;
DECLARE bootstrap_incremental_job_lookback_days INT64 DEFAULT 3;
DECLARE bootstrap_scheduled_query_service_accounts ARRAY<STRING> DEFAULT [
  'audeodb@appspot.gserviceaccount.com'
];
DECLARE bootstrap_dag_service_accounts ARRAY<STRING> DEFAULT [
  'audeodb@appspot.gserviceaccount.com'
];

DECLARE bootstrap_parser_strict_mode BOOL DEFAULT FALSE;
DECLARE bootstrap_compact_export BOOL DEFAULT TRUE;
DECLARE bootstrap_max_impact_rank INT64 DEFAULT 100;

DECLARE repository_dataset_full_name STRING;
DECLARE config_table_full_name STRING;

DECLARE config STRUCT<
  config_id STRING,
  repository_project_id STRING,
  repository_dataset STRING,
  repository_location STRING,
  udf_project_id STRING,
  udf_dataset STRING,
  udf_function_name STRING,
  udf_library_uri STRING,
  target_project_id STRING,
  target_region STRING,
  target_datasets ARRAY<STRING>,
  initial_job_lookback_days INT64,
  incremental_job_lookback_days INT64,
  parser_strict_mode BOOL,
  compact_export BOOL,
  max_impact_rank INT64
>;

DECLARE smoke_test_result STRING;
DECLARE smoke_test_status STRING;
DECLARE scheduled_query_service_accounts ARRAY<STRING>;
DECLARE dag_service_accounts ARRAY<STRING>;

SET repository_dataset_full_name = FORMAT(
  '%s.%s',
  bootstrap_repository_project_id,
  bootstrap_repository_dataset
);

SET config_table_full_name = FORMAT(
  '%s.lineage_config',
  repository_dataset_full_name
);

-- ============================================================================
-- 1. Repository Dataset
-- ============================================================================
EXECUTE IMMEDIATE FORMAT(
  '''
  CREATE SCHEMA IF NOT EXISTS `%s`
  OPTIONS (
    location = '%s',
    description = 'BigQuery physical lineage repository'
  )
  ''',
  repository_dataset_full_name,
  bootstrap_repository_location
);

-- ============================================================================
-- 2. Typed one-row configuration table
-- ============================================================================
EXECUTE IMMEDIATE FORMAT(
  '''
  CREATE TABLE IF NOT EXISTS `%s`
  (
    config_id STRING NOT NULL,
    repository_project_id STRING NOT NULL,
    repository_dataset STRING NOT NULL,
    repository_location STRING NOT NULL,
    udf_project_id STRING NOT NULL,
    udf_dataset STRING NOT NULL,
    udf_function_name STRING NOT NULL,
    udf_library_uri STRING NOT NULL,
    target_project_id STRING NOT NULL,
    target_region STRING NOT NULL,
    target_datasets ARRAY<STRING>,
    initial_job_lookback_days INT64 NOT NULL,
    incremental_job_lookback_days INT64 NOT NULL,
    parser_strict_mode BOOL NOT NULL,
    compact_export BOOL NOT NULL,
    max_impact_rank INT64 NOT NULL,
    created_at TIMESTAMP NOT NULL,
    updated_at TIMESTAMP NOT NULL
  )
  CLUSTER BY config_id
  OPTIONS (
    description = 'Typed environment and runtime configuration for lineage'
  )
  ''',
  config_table_full_name
);

EXECUTE IMMEDIATE FORMAT(
  '''
  MERGE `%s` AS target
  USING (
    SELECT
      @config_id AS config_id,
      @repository_project_id AS repository_project_id,
      @repository_dataset AS repository_dataset,
      @repository_location AS repository_location,
      @udf_project_id AS udf_project_id,
      @udf_dataset AS udf_dataset,
      @udf_function_name AS udf_function_name,
      @udf_library_uri AS udf_library_uri,
      @target_project_id AS target_project_id,
      @target_region AS target_region,
      @target_datasets AS target_datasets,
      @initial_job_lookback_days AS initial_job_lookback_days,
      @incremental_job_lookback_days AS incremental_job_lookback_days,
      @parser_strict_mode AS parser_strict_mode,
      @compact_export AS compact_export,
      @max_impact_rank AS max_impact_rank
  ) AS source
  ON target.config_id = source.config_id
  WHEN MATCHED THEN
    UPDATE SET
      repository_project_id = source.repository_project_id,
      repository_dataset = source.repository_dataset,
      repository_location = source.repository_location,
      udf_project_id = source.udf_project_id,
      udf_dataset = source.udf_dataset,
      udf_function_name = source.udf_function_name,
      udf_library_uri = source.udf_library_uri,
      target_project_id = source.target_project_id,
      target_region = source.target_region,
      target_datasets = source.target_datasets,
      initial_job_lookback_days = source.initial_job_lookback_days,
      incremental_job_lookback_days =
        source.incremental_job_lookback_days,
      parser_strict_mode = source.parser_strict_mode,
      compact_export = source.compact_export,
      max_impact_rank = source.max_impact_rank,
      updated_at = CURRENT_TIMESTAMP()
  WHEN NOT MATCHED THEN
    INSERT (
      config_id,
      repository_project_id,
      repository_dataset,
      repository_location,
      udf_project_id,
      udf_dataset,
      udf_function_name,
      udf_library_uri,
      target_project_id,
      target_region,
      target_datasets,
      initial_job_lookback_days,
      incremental_job_lookback_days,
      parser_strict_mode,
      compact_export,
      max_impact_rank,
      created_at,
      updated_at
    )
    VALUES (
      source.config_id,
      source.repository_project_id,
      source.repository_dataset,
      source.repository_location,
      source.udf_project_id,
      source.udf_dataset,
      source.udf_function_name,
      source.udf_library_uri,
      source.target_project_id,
      source.target_region,
      source.target_datasets,
      source.initial_job_lookback_days,
      source.incremental_job_lookback_days,
      source.parser_strict_mode,
      source.compact_export,
      source.max_impact_rank,
      CURRENT_TIMESTAMP(),
      CURRENT_TIMESTAMP()
    )
  ''',
  config_table_full_name
)
USING
  'default' AS config_id,
  bootstrap_repository_project_id AS repository_project_id,
  bootstrap_repository_dataset AS repository_dataset,
  bootstrap_repository_location AS repository_location,
  bootstrap_udf_project_id AS udf_project_id,
  bootstrap_udf_dataset AS udf_dataset,
  bootstrap_udf_function_name AS udf_function_name,
  bootstrap_udf_library_uri AS udf_library_uri,
  bootstrap_target_project_id AS target_project_id,
  bootstrap_target_region AS target_region,
  bootstrap_target_datasets AS target_datasets,
  bootstrap_initial_job_lookback_days AS initial_job_lookback_days,
  bootstrap_incremental_job_lookback_days
    AS incremental_job_lookback_days,
  bootstrap_parser_strict_mode AS parser_strict_mode,
  bootstrap_compact_export AS compact_export,
  bootstrap_max_impact_rank AS max_impact_rank;

EXECUTE IMMEDIATE FORMAT(
  '''
  SELECT STRUCT(
    config_id,
    repository_project_id,
    repository_dataset,
    repository_location,
    udf_project_id,
    udf_dataset,
    udf_function_name,
    udf_library_uri,
    target_project_id,
    target_region,
    target_datasets,
    initial_job_lookback_days,
    incremental_job_lookback_days,
    parser_strict_mode,
    compact_export,
    max_impact_rank
  ) AS config
  FROM `%s`
  WHERE config_id = 'default'
  QUALIFY ROW_NUMBER() OVER (
    ORDER BY updated_at DESC
  ) = 1
  ''',
  config_table_full_name
)
INTO config;

-- ============================================================================
-- 3. Execution service-account configuration
--
-- One row is maintained per execution source. Multiple accounts are stored as
-- ARRAY<STRING>; add entries as comma-separated ARRAY elements in Bootstrap.
-- ============================================================================
EXECUTE IMMEDIATE FORMAT(
  '''
  CREATE TABLE IF NOT EXISTS
    `%s.lineage_execution_account_config`
  (
    execution_source STRING NOT NULL,
    service_accounts ARRAY<STRING>,
    is_active BOOL NOT NULL,
    description STRING,
    created_at TIMESTAMP NOT NULL,
    updated_at TIMESTAMP NOT NULL
  )
  CLUSTER BY execution_source
  OPTIONS (
    description = 'Allowed execution accounts by generated-table source'
  )
  ''',
  repository_dataset_full_name
);

EXECUTE IMMEDIATE FORMAT(
  '''
  MERGE `%s.lineage_execution_account_config` AS target
  USING (
    SELECT
      'SCHEDULED_QUERY' AS execution_source,
      @scheduled_query_accounts AS service_accounts,
      TRUE AS is_active,
      'Scheduled Query execution service accounts' AS description
    UNION ALL
    SELECT
      'DAG' AS execution_source,
      @dag_accounts AS service_accounts,
      TRUE AS is_active,
      'DAG execution service accounts' AS description
  ) AS source
  ON target.execution_source = source.execution_source
  WHEN MATCHED THEN
    UPDATE SET
      service_accounts = source.service_accounts,
      is_active = source.is_active,
      description = source.description,
      updated_at = CURRENT_TIMESTAMP()
  WHEN NOT MATCHED THEN
    INSERT (
      execution_source,
      service_accounts,
      is_active,
      description,
      created_at,
      updated_at
    )
    VALUES (
      source.execution_source,
      source.service_accounts,
      source.is_active,
      source.description,
      CURRENT_TIMESTAMP(),
      CURRENT_TIMESTAMP()
    )
  ''',
  repository_dataset_full_name
)
USING
  bootstrap_scheduled_query_service_accounts
    AS scheduled_query_accounts,
  bootstrap_dag_service_accounts AS dag_accounts;

ASSERT ARRAY_LENGTH(
  bootstrap_scheduled_query_service_accounts
) > 0
AS 'Scheduled Query service-account array must not be empty.';

ASSERT ARRAY_LENGTH(bootstrap_dag_service_accounts) > 0
AS 'DAG service-account array must not be empty.';

EXECUTE IMMEDIATE FORMAT(
  '''
  SELECT
    (
      SELECT service_accounts
      FROM `%s.lineage_execution_account_config`
      WHERE execution_source = 'SCHEDULED_QUERY'
        AND is_active = TRUE
    ),
    (
      SELECT service_accounts
      FROM `%s.lineage_execution_account_config`
      WHERE execution_source = 'DAG'
        AND is_active = TRUE
    )
  ''',
  repository_dataset_full_name,
  repository_dataset_full_name
)
INTO
  scheduled_query_service_accounts,
  dag_service_accounts;

ASSERT config.repository_location = config.target_region
AS 'Repository location and target region must be identical.';

ASSERT ARRAY_LENGTH(config.target_datasets) > 0
AS 'target_datasets must contain at least one dataset.';

ASSERT config.initial_job_lookback_days > 0
AS 'initial_job_lookback_days must be greater than zero.';

ASSERT config.incremental_job_lookback_days > 0
AS 'incremental_job_lookback_days must be greater than zero.';

ASSERT config.max_impact_rank > 0
AS 'max_impact_rank must be greater than zero.';

ASSERT NOT STARTS_WITH(config.udf_library_uri, 'gs://YOUR_')
AS 'Replace bootstrap_udf_library_uri with the uploaded GCS library URI.';

SET repository_dataset_full_name = FORMAT(
  '%s.%s',
  config.repository_project_id,
  config.repository_dataset
);

-- ============================================================================
-- 4. Repository tables
-- ============================================================================
EXECUTE IMMEDIATE FORMAT(
  '''
  CREATE TABLE IF NOT EXISTS `%s.lineage_definition_registry`
  (
    object_project STRING NOT NULL,
    object_dataset STRING NOT NULL,
    object_name STRING NOT NULL,
    object_type STRING NOT NULL,
    generation_type STRING NOT NULL,
    definition_source STRING NOT NULL,
    definition_text STRING,
    definition_hash STRING NOT NULL,
    previous_definition_hash STRING,
    source_job_id STRING,
    source_job_time TIMESTAMP,
    source_user_email STRING,
    is_changed BOOL NOT NULL,
    is_active BOOL NOT NULL,
    analysis_status STRING,
    last_analyzed_hash STRING,
    first_seen_at TIMESTAMP NOT NULL,
    last_seen_at TIMESTAMP NOT NULL,
    last_analyzed_at TIMESTAMP,
    updated_at TIMESTAMP NOT NULL
  )
  CLUSTER BY object_project, object_dataset, object_name
  OPTIONS (
    description = 'Current analyzable SQL definition for each target object'
  )
  ''',
  repository_dataset_full_name
);

EXECUTE IMMEDIATE FORMAT(
  '''
  CREATE TABLE IF NOT EXISTS `%s.lineage_direct_dependency`
  (
    definition_hash STRING NOT NULL,
    source_project STRING,
    source_dataset STRING,
    source_object STRING NOT NULL,
    source_object_type STRING NOT NULL,
    source_column STRING,
    target_project STRING NOT NULL,
    target_dataset STRING NOT NULL,
    target_object STRING NOT NULL,
    target_object_type STRING NOT NULL,
    target_column STRING,
    generation_type STRING NOT NULL,
    dependency_type STRING NOT NULL,
    expression STRING,
    usage_type STRING,
    resolution_status STRING,
    resolution_reason STRING,
    edge_key STRING NOT NULL,
    analyzed_at TIMESTAMP NOT NULL
  )
  CLUSTER BY source_project, source_dataset, source_object, source_column
  OPTIONS (
    description = 'Published direct source-to-target physical dependencies'
  )
  ''',
  repository_dataset_full_name
);

EXECUTE IMMEDIATE FORMAT(
  '''
  CREATE TABLE IF NOT EXISTS `%s.lineage_impact`
  (
    snapshot_at TIMESTAMP NOT NULL,
    origin_project STRING,
    origin_dataset STRING,
    origin_object STRING NOT NULL,
    origin_object_type STRING NOT NULL,
    origin_column STRING,
    impact_rank INT64 NOT NULL,
    impacted_project STRING,
    impacted_dataset STRING,
    impacted_object STRING NOT NULL,
    impacted_object_type STRING NOT NULL,
    impacted_column STRING,
    direct_source_project STRING,
    direct_source_dataset STRING,
    direct_source_object STRING NOT NULL,
    direct_source_object_type STRING NOT NULL,
    direct_source_column STRING,
    dependency_path ARRAY<STRING>,
    path_hash STRING NOT NULL,
    generation_type STRING,
    resolution_status STRING,
    is_cycle BOOL NOT NULL
  )
  PARTITION BY DATE(snapshot_at)
  CLUSTER BY origin_project, origin_dataset, origin_object, origin_column
  OPTIONS (
    description = 'Transitive and ranked downstream impact paths'
  )
  ''',
  repository_dataset_full_name
);

EXECUTE IMMEDIATE FORMAT(
  '''
  CREATE TABLE IF NOT EXISTS `%s.lineage_diagnostic`
  (
    definition_hash STRING NOT NULL,
    object_project STRING NOT NULL,
    object_dataset STRING NOT NULL,
    object_name STRING NOT NULL,
    object_type STRING NOT NULL,
    diagnostic_code STRING NOT NULL,
    engine_stage STRING,
    severity STRING NOT NULL,
    output_column STRING,
    expression STRING,
    message STRING,
    diagnostic_json JSON,
    analyzed_at TIMESTAMP NOT NULL
  )
  CLUSTER BY object_project, object_dataset, object_name, diagnostic_code
  OPTIONS (
    description = 'Parser, resolver, export, and execution diagnostics'
  )
  ''',
  repository_dataset_full_name
);

EXECUTE IMMEDIATE FORMAT(
  '''
  CREATE TABLE IF NOT EXISTS `%s.lineage_job_registry`
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
    execution_source
  OPTIONS (
    description = 'Collected Scheduled Query and DAG-generated table jobs'
  )
  ''',
  repository_dataset_full_name
);

-- ============================================================================
-- 5. Persistent JavaScript UDF using the external GCS bundle
-- ============================================================================
EXECUTE IMMEDIATE FORMAT(
  '''
  CREATE SCHEMA IF NOT EXISTS `%s.%s`
  OPTIONS (
    location = '%s'
  )
  ''',
  config.udf_project_id,
  config.udf_dataset,
  config.repository_location
);

EXECUTE IMMEDIATE FORMAT(
  '''
  CREATE OR REPLACE FUNCTION `%s.%s.%s`(
    sql_text STRING,
    physical_columns_json STRING,
    options_json STRING,
    export_metadata_json STRING
  )
  RETURNS STRING
  LANGUAGE js
  OPTIONS (
    library = [
      '%s'
    ]
  )
  AS r"""
    return analyzeLineageForBigQuery(
      sql_text,
      physical_columns_json,
      options_json,
      export_metadata_json
    );
  """
  ''',
  config.udf_project_id,
  config.udf_dataset,
  config.udf_function_name,
  config.udf_library_uri
);

-- ============================================================================
-- 6. UDF smoke test
-- ============================================================================
EXECUTE IMMEDIATE FORMAT(
  '''
  SELECT `%s.%s.%s`(
    'SELECT customer_id FROM sample_sales',
    TO_JSON_STRING([
      STRUCT(
        '%s.%s.sample_sales' AS table_name,
        'customer_id' AS column_name,
        'customer_id' AS field_path,
        1 AS ordinal_position,
        'STRING' AS data_type,
        'YES' AS is_nullable
      )
    ]),
    TO_JSON_STRING(STRUCT(
      @strict_mode AS strict_mode,
      @compact_export AS compact_export
    )),
    TO_JSON_STRING(STRUCT(
      GENERATE_UUID() AS analysis_id,
      @target_project_id AS view_project,
      @target_dataset AS view_dataset,
      'setup_smoke_test' AS view_name,
      FORMAT_TIMESTAMP(
        '%%FT%%H:%%M:%%E*S%%Ez',
        CURRENT_TIMESTAMP()
      ) AS analyzed_at
    ))
  )
  ''',
  config.udf_project_id,
  config.udf_dataset,
  config.udf_function_name,
  config.target_project_id,
  config.target_datasets[SAFE_OFFSET(0)]
)
INTO smoke_test_result
USING
  config.parser_strict_mode AS strict_mode,
  config.compact_export AS compact_export,
  config.target_project_id AS target_project_id,
  config.target_datasets[SAFE_OFFSET(0)] AS target_dataset;

SET smoke_test_status = COALESCE(
  JSON_VALUE(smoke_test_result, '$.analysis.analysis_status'),
  'UNKNOWN'
);

ASSERT smoke_test_status IN (
  'COMPLETED',
  'COMPLETED_WITH_WARNINGS'
)
AS 'Persistent lineage UDF smoke test did not complete successfully.';

-- ============================================================================
-- 7. Setup summary
-- ============================================================================
SELECT
  config.config_id,
  FORMAT(
    '%s.%s',
    config.repository_project_id,
    config.repository_dataset
  ) AS repository_dataset,
  FORMAT(
    '%s.%s.%s',
    config.udf_project_id,
    config.udf_dataset,
    config.udf_function_name
  ) AS persistent_udf,
  config.udf_library_uri,
  config.target_project_id,
  config.target_region,
  config.target_datasets,
  config.initial_job_lookback_days,
  config.incremental_job_lookback_days,
  scheduled_query_service_accounts,
  dag_service_accounts,
  config.parser_strict_mode,
  config.compact_export,
  config.max_impact_rank,
  smoke_test_status,
  CURRENT_TIMESTAMP() AS setup_finished_at;
