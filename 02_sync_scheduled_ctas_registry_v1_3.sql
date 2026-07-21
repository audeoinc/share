-- EXECUTION ORDER: Initial setup 07 / Daily operation 02
SET @@location = 'asia-northeast1';

-- ============================================================================
-- Scheduled Query / DAG generated table definition synchronization
--
-- Flow:
--   1. Read 60 days on the initial load, then the most recent 3 days.
--   2. Detect Scheduled Query by labels[data_source_id] = scheduled_query.
--   3. Detect DAG by the executing service account.
--   4. MERGE jobs into lineage_job_registry by project_id + job_id.
--   5. Select the latest successful job for each destination table.
--   6. MERGE the latest SQL into lineage_definition_registry.
-- ============================================================================

DECLARE run_started_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP();

DECLARE initial_lookback_days INT64 DEFAULT 60;
DECLARE incremental_lookback_days INT64 DEFAULT 3;
DECLARE lookback_days INT64;

DECLARE dag_service_accounts ARRAY<STRING> DEFAULT [
  'DAG_SERVICE_ACCOUNT@example.iam.gserviceaccount.com'
];

CREATE TABLE IF NOT EXISTS
  `audeodb.lineage_repository.lineage_job_registry`
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


-- Initial load:
--   If lineage_job_registry is empty, read 60 days so monthly jobs can be found.
--
-- Incremental load:
--   Once at least one job has been stored, read only the most recent 3 days.
SET lookback_days = IF(
  (
    SELECT COUNT(*)
    FROM `audeodb.lineage_repository.lineage_job_registry`
  ) = 0,
  initial_lookback_days,
  incremental_lookback_days
);

CREATE TEMP TABLE recent_generated_table_jobs AS
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
    EXISTS (
      SELECT 1
      FROM UNNEST(labels) AS label
      WHERE label.key = 'data_source_id'
        AND label.value = 'scheduled_query'
    ) AS is_scheduled_query,
    user_email IN UNNEST(dag_service_accounts) AS is_dag
  FROM
    `audeodb.region-asia-northeast1`.INFORMATION_SCHEMA.JOBS_BY_PROJECT
  WHERE
    creation_time >= TIMESTAMP_SUB(
      CURRENT_TIMESTAMP(),
      INTERVAL lookback_days DAY
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
      WHEN is_scheduled_query THEN 'LABEL'
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

MERGE
  `audeodb.lineage_repository.lineage_job_registry` AS target
USING
  recent_generated_table_jobs AS source
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

CREATE TEMP TABLE latest_generated_table_definitions AS
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
FROM
  `audeodb.lineage_repository.lineage_job_registry`
QUALIFY
  ROW_NUMBER() OVER (
    PARTITION BY
      destination_project,
      destination_dataset,
      destination_table
    ORDER BY
      creation_time DESC,
      job_id DESC
  ) = 1;

MERGE
  `audeodb.lineage_repository.lineage_definition_registry` AS target
USING
  latest_generated_table_definitions AS source
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

SELECT
  run_started_at,
  CURRENT_TIMESTAMP() AS run_finished_at,
  initial_lookback_days,
  incremental_lookback_days,
  lookback_days,
  (
    SELECT COUNT(*)
    FROM recent_generated_table_jobs
  ) AS recent_target_job_count,
  (
    SELECT COUNT(*)
    FROM recent_generated_table_jobs
    WHERE execution_source = 'SCHEDULED_QUERY'
  ) AS recent_scheduled_query_job_count,
  (
    SELECT COUNT(*)
    FROM recent_generated_table_jobs
    WHERE execution_source = 'DAG'
  ) AS recent_dag_job_count,
  (
    SELECT COUNT(*)
    FROM `audeodb.lineage_repository.lineage_job_registry`
  ) AS stored_job_count,
  (
    SELECT COUNT(*)
    FROM `audeodb.lineage_repository.lineage_definition_registry`
    WHERE object_type = 'TABLE'
      AND generation_type IN ('SCHEDULED_QUERY', 'DAG')
      AND is_active = TRUE
  ) AS active_generated_table_count;
