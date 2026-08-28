-- ============================================================================
-- 01_setup_lineage_environment.sql
-- BigQuery Physical Lineage Repository - Environment setup
-- ============================================================================
SET @@location = 'asia-northeast1';

-- ============================================================================
-- Bootstrap values
--
-- Edit this section when installing the repository in another environment.
-- These values are used directly by the setup steps below.
--
-- There is no lineage_config table: the daily pipeline
-- (03_run_daily_lineage_pipeline.sql) is configured independently in its own
-- top-of-file parameter block. This script only creates/replaces the repository
-- tables and the persistent UDF, so it only needs the values below. Runtime
-- knobs (job lookback, max impact rank, scan scope, service accounts) live in
-- 03 and are intentionally not duplicated here.
--
-- Prerequisite:
--   Upload lineage_udf_bundle.js to the configured GCS URI before execution.
-- ============================================================================
-- ============================================================================
-- CONFIGURATION (edit here)
-- ============================================================================
-- Settings are split so it is obvious what to touch:
--   [A] REQUIRED per deployment / region -- review and set these every time.
--   [B] BEHAVIOR OPTIONS -- safe to leave at the defaults; tune as needed.
--   [C] DERIVED / INTERNAL -- computed from [A] or @@location; DO NOT edit.
-- The REGION is set once at `SET @@location` at the top of this file.
--
-- ----------------------------------------------------------------------------
-- [A] REQUIRED per deployment / region -- set these
-- ----------------------------------------------------------------------------
-- Variables are grouped by purpose below; each group is labeled with a one-line
-- header. Full descriptions follow the block under "Variable notes".
-- GCP project: auto-detected at runtime; its DECLARE lives in [B] (pin it there
-- only to run against a different project).
-- Project-token substitution
DECLARE bootstrap_project_token_pattern STRING DEFAULT r'^([^-]+)';
-- Datasets (repository / UDF)
DECLARE bootstrap_repository_dataset STRING DEFAULT 'lineage_repository';
DECLARE bootstrap_udf_dataset STRING DEFAULT 'dataset';
-- Table naming (prefix / suffix)
DECLARE bootstrap_table_name_prefix STRING DEFAULT '';
DECLARE bootstrap_table_name_suffix STRING DEFAULT '';
-- UDF naming (prefix / suffix)
DECLARE bootstrap_udf_name_prefix STRING DEFAULT '';
DECLARE bootstrap_udf_name_suffix STRING DEFAULT '';
-- UDF JS bundle location (GCS)
DECLARE bootstrap_udf_library_uri STRING DEFAULT
  'gs://YOUR_BUCKET/YOUR_PATH/lineage_udf_bundle.js';
--
-- Variable notes (keyed by name):
--   bootstrap_project_token_pattern
--     Project-token substitution. A token extracted from the auto-detected project
--     id by this regex (REGEXP_EXTRACT; if it has a capture group, group 1 is
--     used) is substituted for every literal '{project_token}' placeholder in the
--     dataset names and the table/view/UDF prefixes & suffixes below. Example: for
--     project id 'mycompany-prod-123', pattern r'-([^-]+)-' yields 'prod', so a
--     dataset written as 'lineage_repository_{project_token}' becomes
--     'lineage_repository_prod'. Set the pattern to match your project-id format;
--     the default takes the first hyphen-delimited segment. An unmatched pattern
--     yields '' (empty), and any '{project_token}' left unreplaced fails the name
--     ASSERTs (so typos surface).
--   bootstrap_repository_dataset / bootstrap_udf_dataset
--     Repository dataset (holds the lineage_* tables) and UDF dataset (holds the
--     functions created here). Their *_project_id are in [C].
--   bootstrap_table_name_prefix / bootstrap_table_name_suffix
--     Repository table naming. Physical table names are assembled as
--       prefix + marker + canonical base name + suffix
--     in the SET lines below. The prefix and suffix change per environment (e.g. a
--     region tag like suffix='_tky'); the master/transaction marker ('m_' / 't_')
--     is an inline literal in each SET line (edit it only to reclassify a table).
--     Include any '_' separators in the prefix and suffix; leave a segment empty
--     to omit it. Allowed characters: letters, digits, '_', and '-' (every
--     reference to these tables is backtick-quoted, so a hyphen like suffix='-tky'
--     is safe). Dataset and UDF names still allow only letters/digits/'_' (no '-').
--   bootstrap_udf_name_prefix / bootstrap_udf_name_suffix
--     UDF (routine) naming. UDF names are assembled as
--       udf_prefix + 'lnge_' + canonical base + udf_suffix
--     in [C], keeping the system 'lnge_' identity. Kept separate from the table
--     prefix/suffix because routine names allow only letters/digits/'_' (no '-',
--     unlike backtick-quoted tables); a hyphen here fails the UDF name ASSERT.
--   bootstrap_udf_library_uri
--     GCS URI of the uploaded lineage_udf_bundle.js (deployment-specific).

-- ----------------------------------------------------------------------------
-- [B] BEHAVIOR OPTIONS -- defaults are safe; tune as needed
-- ----------------------------------------------------------------------------
-- Single source of truth for the GCP project. Declared here (not in [A]) because
-- it is normally not set by hand: it is auto-detected in [C] from
-- INFORMATION_SCHEMA.SCHEMATA (the project the job runs in). To pin it instead,
-- set a literal in [C]. The repository, the UDFs, and the smoke-test target all
-- live in this one project; the role-specific bootstrap_*_project_id variables
-- live in [C] and take this unless individually pinned.
DECLARE bootstrap_default_project_id STRING;
-- UDF function names created in bootstrap_udf_dataset (assembled in [C] from the
-- udf prefix/suffix above; keep them in step with 03). The main analysis UDF, the
-- structural-fingerprint UDF (collapses rotating-destination JOBS; same GCS
-- bundle), and the dynamic-SQL identifier renderer.
DECLARE bootstrap_udf_function_name STRING;
DECLARE bootstrap_udf_fingerprint_function_name STRING;
DECLARE bootstrap_udf_render_function_name STRING;
-- Looker Studio 向けの HTML 生成 UDF（本体は下の生成ブロックが SET する JS）。
-- 他の UDF と同じ udf prefix/suffix・同じ bootstrap_udf_dataset に作る。
DECLARE bootstrap_udf_usage_sql_html_function_name STRING;
DECLARE bootstrap_udf_usage_sql_css_function_name STRING;
-- Target dataset(s) used only by the UDF smoke test below (to build a
-- representative physical-column identity). The pipeline's own scan scope is set
-- in 03_run_daily_lineage_pipeline.sql.
DECLARE bootstrap_target_datasets ARRAY<STRING> DEFAULT ['dataset'];
-- Smoke-test parser options (mirror 03's parser_strict_mode / compact_export).
DECLARE bootstrap_parser_strict_mode BOOL DEFAULT FALSE;
DECLARE bootstrap_compact_export BOOL DEFAULT TRUE;

-- Views-only re-deploy. Section 4 recreates the repository TABLES with
-- CREATE OR REPLACE, which DESTROYS their contents -- so once a repository is live
-- this script must not be re-run just to pick up a view change. Set TRUE to skip
-- everything destructive or slow (the table DDL in section 4, the renderer / UDF
-- deploy in 4b and 5, and the smoke tests in 6) and only recreate the views in
-- section 4a. The naming knobs above still apply, so the views are rebuilt over
-- exactly the tables this deployment uses. Leave FALSE for a first-time setup.
DECLARE recreate_views_only BOOL DEFAULT FALSE;

-- ----------------------------------------------------------------------------
-- [C] DERIVED / INTERNAL -- computed from [A] or @@location; DO NOT edit
-- ----------------------------------------------------------------------------
-- Role-specific projects take bootstrap_default_project_id (auto-detected below);
-- to pin one role to a separate project, set its DEFAULT to a literal here (a
-- non-NULL value wins via COALESCE in the SET block below). The repository
-- location mirrors @@location (the single source of truth set at the top).
DECLARE bootstrap_repository_project_id STRING DEFAULT NULL;
DECLARE bootstrap_repository_location STRING DEFAULT @@location;
DECLARE bootstrap_udf_project_id STRING DEFAULT NULL;
DECLARE bootstrap_target_project_id STRING DEFAULT NULL;

-- Repository physical table names, assembled by the SET lines below from
-- bootstrap_table_name_prefix / _suffix ([A]); plus smoke-test work variables.
DECLARE table_definition_registry STRING;
DECLARE table_direct_dependency STRING;
DECLARE table_impact STRING;
DECLARE table_diagnostic STRING;
DECLARE table_job_registry STRING;
DECLARE table_column_usage STRING;
DECLARE view_column_usage_impact STRING;
DECLARE view_object_dependency STRING;
-- HTML 生成 UDF の本体 JS。build_usage_html_udf.js が生成ブロックで SET する。
DECLARE usage_html_udf_js STRING;

DECLARE repository_dataset_full_name STRING;
-- Token extracted from the project id (see bootstrap_project_token_pattern).
DECLARE bootstrap_project_token STRING;

DECLARE smoke_test_result STRING;
DECLARE smoke_test_status STRING;
DECLARE fingerprint_smoke_result BOOL;

-- Auto-detect the running GCP project from INFORMATION_SCHEMA.SCHEMATA
-- (catalog_name = the project the job runs in). The region-qualified identifier
-- cannot be parameterized, so it is built from @@location. To pin the project,
-- replace this SET with a literal (e.g. SET bootstrap_default_project_id =
-- 'my-project';). Role projects then take it unless individually pinned above.
EXECUTE IMMEDIATE FORMAT(
  "SELECT DISTINCT catalog_name FROM `region-%s`.INFORMATION_SCHEMA.SCHEMATA LIMIT 1",
  @@location
) INTO bootstrap_default_project_id;
ASSERT bootstrap_default_project_id IS NOT NULL AS
  'Could not auto-detect the project id from INFORMATION_SCHEMA.SCHEMATA (no datasets in this region?); set bootstrap_default_project_id to a literal.';
SET bootstrap_repository_project_id =
  COALESCE(bootstrap_repository_project_id, bootstrap_default_project_id);
SET bootstrap_udf_project_id =
  COALESCE(bootstrap_udf_project_id, bootstrap_default_project_id);
SET bootstrap_target_project_id =
  COALESCE(bootstrap_target_project_id, bootstrap_default_project_id);

-- Extract the project token and substitute it for the '{project_token}'
-- placeholder in every name input BEFORE the names are assembled/asserted.
SET bootstrap_project_token =
  COALESCE(REGEXP_EXTRACT(bootstrap_default_project_id, bootstrap_project_token_pattern), '');
SET bootstrap_repository_dataset =
  REPLACE(bootstrap_repository_dataset, '{project_token}', bootstrap_project_token);
SET bootstrap_udf_dataset =
  REPLACE(bootstrap_udf_dataset, '{project_token}', bootstrap_project_token);
SET bootstrap_table_name_prefix =
  REPLACE(bootstrap_table_name_prefix, '{project_token}', bootstrap_project_token);
SET bootstrap_table_name_suffix =
  REPLACE(bootstrap_table_name_suffix, '{project_token}', bootstrap_project_token);
SET bootstrap_udf_name_prefix =
  REPLACE(bootstrap_udf_name_prefix, '{project_token}', bootstrap_project_token);
SET bootstrap_udf_name_suffix =
  REPLACE(bootstrap_udf_name_suffix, '{project_token}', bootstrap_project_token);
SET bootstrap_udf_library_uri =
  REPLACE(bootstrap_udf_library_uri, '{project_token}', bootstrap_project_token);
SET bootstrap_target_datasets = ARRAY(
  SELECT REPLACE(d, '{project_token}', bootstrap_project_token)
  FROM UNNEST(bootstrap_target_datasets) AS d
);

-- Guard: surface an unsubstituted '{project_token}' (or any invalid character) in a
-- name input here, rather than as a confusing failure at DDL time. Dataset names
-- must be valid identifiers (letters/digits/underscore); the GCS library URI is not
-- an identifier, so it is only checked for a leftover placeholder.
ASSERT REGEXP_CONTAINS(bootstrap_repository_dataset, r'^[A-Za-z0-9_]+$')
  AS 'bootstrap_repository_dataset must be letters/digits/underscore only (check for an unsubstituted {project_token}).';
ASSERT REGEXP_CONTAINS(bootstrap_udf_dataset, r'^[A-Za-z0-9_]+$')
  AS 'bootstrap_udf_dataset must be letters/digits/underscore only (check for an unsubstituted {project_token}).';
ASSERT NOT EXISTS (
  SELECT 1 FROM UNNEST(bootstrap_target_datasets) AS d
  WHERE NOT REGEXP_CONTAINS(d, r'^[A-Za-z0-9_]+$')
) AS 'Each bootstrap_target_datasets entry must be letters/digits/underscore only (check for an unsubstituted {project_token}).';
ASSERT STRPOS(bootstrap_udf_library_uri, '{project_token}') = 0
  AS 'bootstrap_udf_library_uri still contains {project_token}; check bootstrap_project_token_pattern.';

-- UDF names: udf_prefix + 'lnge_' + canonical base + udf_suffix (no marker).
SET bootstrap_udf_function_name =
  bootstrap_udf_name_prefix || 'lnge_' || 'analyze_json' || bootstrap_udf_name_suffix;
SET bootstrap_udf_fingerprint_function_name =
  bootstrap_udf_name_prefix || 'lnge_' || 'fingerprint_sql' || bootstrap_udf_name_suffix;
SET bootstrap_udf_render_function_name =
  bootstrap_udf_name_prefix || 'lnge_' || 'render_dynamic_sql' || bootstrap_udf_name_suffix;
SET bootstrap_udf_usage_sql_html_function_name =
  bootstrap_udf_name_prefix || 'lnge_' || 'usage_sql_html' || bootstrap_udf_name_suffix;
SET bootstrap_udf_usage_sql_css_function_name =
  bootstrap_udf_name_prefix || 'lnge_' || 'usage_sql_css' || bootstrap_udf_name_suffix;
ASSERT REGEXP_CONTAINS(bootstrap_udf_function_name, r'^[A-Za-z0-9_]+$')
AS 'Invalid udf function name (letters/digits/_ only; no hyphen in udf prefix/suffix).';
ASSERT REGEXP_CONTAINS(bootstrap_udf_fingerprint_function_name, r'^[A-Za-z0-9_]+$')
AS 'Invalid udf fingerprint function name (letters/digits/_ only; no hyphen).';
ASSERT REGEXP_CONTAINS(bootstrap_udf_render_function_name, r'^[A-Za-z0-9_]+$')
AS 'Invalid udf render function name (letters/digits/_ only; no hyphen).';
ASSERT REGEXP_CONTAINS(bootstrap_udf_usage_sql_html_function_name, r'^[A-Za-z0-9_]+$')
AS 'Invalid udf usage_sql_html function name (letters/digits/_ only; no hyphen).';
ASSERT REGEXP_CONTAINS(bootstrap_udf_usage_sql_css_function_name, r'^[A-Za-z0-9_]+$')
AS 'Invalid udf usage_sql_css function name (letters/digits/_ only; no hyphen).';

-- Physical table names: prefix + marker + canonical base + suffix.
-- The 'm_' / 't_' marker literal is inline; edit it to reclassify a table.
SET table_definition_registry =
  bootstrap_table_name_prefix || 'lnge_' || 'm_' || 'definition_registry'
    || bootstrap_table_name_suffix;
SET table_job_registry =
  bootstrap_table_name_prefix || 'lnge_' || 'm_' || 'job_registry'
    || bootstrap_table_name_suffix;
SET table_direct_dependency =
  bootstrap_table_name_prefix || 'lnge_' || 't_' || 'direct_dependency'
    || bootstrap_table_name_suffix;
SET table_impact =
  bootstrap_table_name_prefix || 'lnge_' || 't_' || 'impact'
    || bootstrap_table_name_suffix;
SET table_diagnostic =
  bootstrap_table_name_prefix || 'lnge_' || 't_' || 'diagnostic'
    || bootstrap_table_name_suffix;
SET table_column_usage =
  bootstrap_table_name_prefix || 'lnge_' || 't_' || 'column_usage'
    || bootstrap_table_name_suffix;
-- View naming convention: prefix + 'vw_' + marker + canonical base + suffix, where
-- the marker is 't_' / 'm_' (transaction / master) like the tables. This view is
-- built over the transaction tables lnge_t_column_usage / lnge_t_impact, so
-- its marker is 't_' -> lnge_vw_t_column_usage_impact.
SET view_column_usage_impact =
  bootstrap_table_name_prefix || 'lnge_' || 'vw_' || 't_' || 'column_usage_impact'
    || bootstrap_table_name_suffix;
-- Object (table/view) level dependency view, aggregated from the same transaction
-- table as the impact view, so its marker is 't_' -> lnge_vw_t_object_dependency.
SET view_object_dependency =
  bootstrap_table_name_prefix || 'lnge_' || 'vw_' || 't_' || 'object_dependency'
    || bootstrap_table_name_suffix;

ASSERT REGEXP_CONTAINS(table_definition_registry, r'^[A-Za-z0-9_-]+$')
AS 'Invalid table_definition_registry name.';
ASSERT REGEXP_CONTAINS(table_direct_dependency, r'^[A-Za-z0-9_-]+$')
AS 'Invalid table_direct_dependency name.';
ASSERT REGEXP_CONTAINS(table_impact, r'^[A-Za-z0-9_-]+$')
AS 'Invalid table_impact name.';
ASSERT REGEXP_CONTAINS(table_diagnostic, r'^[A-Za-z0-9_-]+$')
AS 'Invalid table_diagnostic name.';
ASSERT REGEXP_CONTAINS(table_job_registry, r'^[A-Za-z0-9_-]+$')
AS 'Invalid table_job_registry name.';
ASSERT REGEXP_CONTAINS(table_column_usage, r'^[A-Za-z0-9_-]+$')
AS 'Invalid table_column_usage name.';
ASSERT REGEXP_CONTAINS(view_column_usage_impact, r'^[A-Za-z0-9_-]+$')
AS 'Invalid view_column_usage_impact name.';
ASSERT REGEXP_CONTAINS(view_object_dependency, r'^[A-Za-z0-9_-]+$')
AS 'Invalid view_object_dependency name.';

SET repository_dataset_full_name = FORMAT(
  '%s.%s',
  bootstrap_repository_project_id,
  bootstrap_repository_dataset
);

-- ============================================================================
-- 1. Repository Dataset
--
-- Dataset (SCHEMA) creation is intentionally disabled. The repository dataset
-- is expected to already exist; this setup script only creates/replaces the
-- tables and the UDF within it. Uncomment the block below to have the script
-- create the dataset.
-- ============================================================================
-- EXECUTE IMMEDIATE FORMAT(
--   '''
--   CREATE SCHEMA IF NOT EXISTS `%s`
--   OPTIONS (
--     location = '%s',
--     description = 'BigQuery physical lineage repository'
--   )
--   ''',
--   repository_dataset_full_name,
--   bootstrap_repository_location
-- );

-- ============================================================================
-- 2. Bootstrap validation
--
-- The typed lineage_config table has been removed; the daily pipeline is
-- configured directly in 03_run_daily_lineage_pipeline.sql. These checks
-- validate the bootstrap values this setup script relies on.
-- ============================================================================
ASSERT NOT STARTS_WITH(bootstrap_udf_library_uri, 'gs://YOUR_')
AS 'Replace bootstrap_udf_library_uri with the uploaded GCS library URI.';

ASSERT ARRAY_LENGTH(bootstrap_target_datasets) > 0
AS 'bootstrap_target_datasets must contain at least one dataset.';

-- ============================================================================
-- 3. Execution service-account configuration
--
-- Removed. Execution service accounts (Scheduled Query / DAG) are no longer
-- stored in a repository table; they are declared directly in the STEP 2
-- parameter block of 03_run_daily_lineage_pipeline.sql, so the pipeline is
-- configured in a single file and no separate table needs maintaining.
-- ============================================================================

-- ============================================================================
-- 4. Repository tables
--
-- CREATE OR REPLACE TABLE: every statement here DROPS AND RECREATES its table, so
-- the whole section is skipped when recreate_views_only is TRUE.
-- ============================================================================
IF NOT recreate_views_only THEN
EXECUTE IMMEDIATE FORMAT(
  '''
  CREATE OR REPLACE TABLE `%s.%s`
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
    -- Structural fingerprint (literal-normalized SHA256) of the SQL. Set for
    -- JOBS-derived objects; NULL for Views. For EPHEMERAL objects it is also the
    -- definition_hash and the identity key. Persistent generated tables carry it
    -- for reference but keep a text-based definition_hash and real identity.
    sql_fingerprint STRING,
    -- TRUE for JOBS-derived objects whose destination does not persist (temp /
    -- rotating-name jobs), which are collapsed by fingerprint to one stable
    -- synthetic identity `<project>.<ephemeral_dataset>.fp_<hash>`. FALSE for
    -- Views and persistent generated tables (which keep their real identity).
    is_ephemeral BOOL,
    source_job_id STRING,
    source_job_time TIMESTAMP,
    source_user_email STRING,
    -- Job labels (dag_id, task_id, ...) carried over from the source job for
    -- generated TABLEs, so a FAILED object can be traced to its DAG without
    -- joining to the job registry. NULL for Views (which have no job labels).
    labels ARRAY<STRUCT<key STRING, value STRING>>,
    -- Variable names DECLAREd in the parent BigQuery script (resolved via the
    -- job's parent_job_id) for JOBS-derived objects that are child statements of a
    -- multi-statement script. Passed to the analysis UDF as script_variables so an
    -- unqualified reference to a script variable -- which is indistinguishable from
    -- a column in the child statement's stored SQL text -- is treated as an opaque
    -- value instead of a missing column. NULL / empty for Views and non-script jobs.
    script_variables ARRAY<STRING>,
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
  repository_dataset_full_name,
  table_definition_registry
);

-- MIGRATION (existing deployments): this CREATE OR REPLACE recreates the registry
-- from scratch, which is fine for a fresh setup but would drop data on an existing
-- repository. To add the script_variables column in place without losing data, run
-- once instead of re-running this CREATE:
--   ALTER TABLE `<project>.<dataset>.<lnge_m_definition_registry>`
--     ADD COLUMN IF NOT EXISTS script_variables ARRAY<STRING>;

EXECUTE IMMEDIATE FORMAT(
  '''
  CREATE OR REPLACE TABLE `%s.%s`
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
  repository_dataset_full_name,
  table_direct_dependency
);

EXECUTE IMMEDIATE FORMAT(
  '''
  CREATE OR REPLACE TABLE `%s.%s`
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
  repository_dataset_full_name,
  table_impact
);

EXECUTE IMMEDIATE FORMAT(
  '''
  CREATE OR REPLACE TABLE `%s.%s`
  (
    definition_hash STRING NOT NULL,
    object_project STRING NOT NULL,
    object_dataset STRING NOT NULL,
    object_name STRING NOT NULL,
    object_type STRING NOT NULL,
    -- How this object's SQL was obtained: 'VIEW_DEFINITION' for a View (its SQL is
    -- INFORMATION_SCHEMA.VIEWS.view_definition), or a job execution source
    -- ('SCHEDULED_QUERY' / 'DAG' / ...) for a generated table (its SQL is the
    -- INFORMATION_SCHEMA.JOBS query). Lets a reader tell a view definition from a
    -- job SQL without joining the registry (object_type only says VIEW vs TABLE).
    generation_type STRING,
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
  repository_dataset_full_name,
  table_diagnostic
);

EXECUTE IMMEDIATE FORMAT(
  '''
  CREATE OR REPLACE TABLE `%s.%s`
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
    -- Structural fingerprint (literal-normalized SHA256), computed for every
    -- collected job. Jobs whose SQL differs only in literals share one
    -- fingerprint; used to collapse rotating-destination (temp/ephemeral) jobs.
    sql_fingerprint STRING,
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
  repository_dataset_full_name,
  table_job_registry
);

-- MIGRATION (existing deployments): this table is new. Re-running 01 recreates it
-- (CREATE OR REPLACE, destructive for the other tables too), but 03 also issues a
-- CREATE TABLE IF NOT EXISTS for it at startup, so an existing deployment picks it
-- up on the next pipeline run without re-running 01. Keep this schema and 03's
-- IF NOT EXISTS copy in step.
--
-- Column usage index: one row per resolved physical-column reference inside a
-- published object's SQL, across ALL clauses (SELECT / WHERE / JOIN / GROUP BY /
-- HAVING / QUALIFY / ORDER BY), not only value-flow (SELECT) lineage. Answers
-- "where and how is <table/view>.<column> used" for impact review: which object,
-- which line, and in what clause. Populated by 03 STEP 3 from the analysis UDF's
-- physical_column_references (which now carry line_number / line_text). Filter by
-- the source_* columns to find every place a given column is referenced; join to
-- the impact table (origin/impacted + dependency_path) for the transitive
-- downstream reach and to trace a downstream SELECTed column back to its origin.
EXECUTE IMMEDIATE FORMAT(
  '''
  CREATE OR REPLACE TABLE `%s.%s`
  (
    -- Referenced physical column (the selectable object.column in the report).
    source_project STRING,
    source_dataset STRING,
    source_object STRING NOT NULL,
    source_object_type STRING NOT NULL,
    source_column STRING NOT NULL,
    source_field_path STRING,
    -- Object whose SQL contains the reference.
    object_project STRING NOT NULL,
    object_dataset STRING NOT NULL,
    object_name STRING NOT NULL,
    object_type STRING NOT NULL,
    generation_type STRING NOT NULL,
    definition_hash STRING NOT NULL,
    -- How and where it is used.
    usage_type STRING NOT NULL,
    reference_name STRING,
    line_number INT64,
    column_number INT64,
    -- The single source line that contains the reference token (per requirement;
    -- the full expression is identifiable via reference_name).
    line_text STRING,
    resolution_status STRING,
    -- Stable identity of one usage site (object + source column + clause +
    -- position), so a re-publish of the same object is idempotent.
    usage_key STRING NOT NULL,
    analyzed_at TIMESTAMP NOT NULL
  )
  CLUSTER BY source_project, source_dataset, source_object, source_column
  OPTIONS (
    description = 'Per-reference column usage index (all clauses) for impact review'
  )
  ''',
  repository_dataset_full_name,
  table_column_usage
);

END IF;  -- NOT recreate_views_only (section 4: repository tables)

-- ============================================================================
-- 4a-0. HTML 生成 UDF -- ビューが参照するため、ビューより先に作る。
--
-- CREATE OR REPLACE FUNCTION は非破壊なので recreate_views_only の実行でも作る
-- （ビューがこの関数に依存しているため、views-only でスキップしてはならない）。
-- ============================================================================
-- BEGIN GENERATED: usage SQL HTML UDF (build_usage_html_udf.js)
-- このブロックは自動生成です。直接編集せず、src/html/usage_sql_html.js を直して
-- `node scripts/build_usage_html_udf.js` で作り直すこと。
--
-- 使用箇所つき SQL を HTML にして返す UDF。Looker Studio の Templated Record に
-- HTML カラムとして渡す用途。GCS も外部ライブラリも使わない自己完結の関数なので、
-- エンジン バンドル (lineage_udf_bundle.js) とは無関係で再デプロイも不要。
--
-- 他の UDF（analyze_json / fingerprint_sql / render_dynamic_sql）と同じ扱いで、
-- 同じ udf prefix/suffix・同じ bootstrap_udf_dataset に作られる。
--
-- <udf_prefix>lnge_usage_sql_html<udf_suffix>(sql_text, highlights, options_json)
--   sql_text     対象オブジェクトの SQL 本文
--   highlights   'line:column:length' の配列。重複と重なりは関数側で畳む
--   options_json 表示オプション。NULL / '{}' で既定
--     mode         'embed'(既定) <style> 同梱で自己完結 / 'class' markup のみ
--                  (CSS は LNGE_USAGE_SQL_CSS() をテンプレートに貼る。最小) /
--                  'inline' すべてインライン CSS
--     contextLines 該当行の前後 N 行だけ描画（既定は指定なし＝全文）
--     maxLines     描画する最大行数（既定 5000）
--     fontSize / lineHeight / colors.* / syntax.*
--
-- <udf_prefix>lnge_usage_sql_css<udf_suffix>(options_json)
--   mode='class' のときテンプレートに貼る CSS。色を変えたら同じ options_json を
--   渡して作り直すこと（markup と CSS は同じコードから作られるので食い違わない）。
-- 変数はスクリプト先頭の [C] で DECLARE 済み（BigQuery は DECLARE を
-- 最初の文より前に置く必要があるため、ここでは SET だけを行う）。
SET usage_html_udf_js = r'''
/**
 * 使用箇所つき SQL を HTML へ描画するレンダラ。
 *
 * Looker Studio のコミュニティ ビジュアライゼーション "Templated Record" に
 * HTML 文字列のカラムを渡して描画させるためのもの。Templated Record は
 * ギャラリー掲載品で公開元がホストしているため、GCS バケットを公開する必要がない
 * （自作ビジュアライゼーションは公開バケットが必須で、それが禁止の環境では使えない）。
 *
 * 描画するもの:
 *   - 行番号つきの SQL 全文
 *   - 該当行の行ハイライト
 *   - 該当箇所（複数可）の文字ハイライト
 *   - SQL の簡易構文ハイライト
 *
 * ハイライト位置は "line:column:length" の文字列で受け取る。line / column は
 * リポジトリの line_number / column_number と同じ 1 始まりで、column は
 * 行頭インデントを含む文字位置（タブは 1 文字）。したがってタブを空白へ展開しては
 * ならない（位置がずれる）。表示側は white-space:pre-wrap で見た目を保つ。
 *
 * このモジュールは BigQuery の JS UDF 本体として埋め込まれる（scripts/
 * build_usage_html_udf.js が 01 の生成ブロックへ差し込む）。BigQuery の
 * インライン コード ブロブは 32KB が上限なので、追加時はサイズに注意すること。
 */

/* 予約語。色分けの対象。網羅ではなく、読みやすさに効くものを選んでいる。 */
const SQL_KEYWORDS = new Set(
  ("SELECT FROM WHERE JOIN INNER LEFT RIGHT FULL OUTER CROSS ON USING " +
   "AND OR NOT IN IS NULL LIKE BETWEEN EXISTS ANY ALL SOME " +
   "GROUP BY HAVING QUALIFY ORDER ASC DESC LIMIT OFFSET " +
   "UNION INTERSECT EXCEPT DISTINCT AS CASE WHEN THEN ELSE END " +
   "WITH RECURSIVE OVER PARTITION WINDOW UNNEST STRUCT ARRAY " +
   "CREATE OR REPLACE TABLE VIEW FUNCTION TEMP TEMPORARY IF " +
   "INSERT INTO VALUES UPDATE SET DELETE MERGE MATCHED " +
   "CAST SAFE_CAST INTERVAL EXTRACT TRUE FALSE " +
   "INT64 FLOAT64 NUMERIC STRING BYTES BOOL DATE DATETIME TIME TIMESTAMP JSON"
  ).split(/\s+/)
);

const DEFAULTS = {
  mode: "embed",
  contextLines: null,
  maxLines: 5000,
  fontSize: 12,
  lineHeight: 1.45,
  font: "'Roboto Mono','SFMono-Regular',Consolas,'Liberation Mono',Menlo,monospace",
  text: "#24292F",
  num: "#8C959F",
  numBg: "#F6F8FA",
  border: "#D8DEE4",
  hitBg: "#FFF8C5",
  hitBar: "#D4A72C",
  markBg: "#FFE58F",
  gapBg: "#F6F8FA",
  gapText: "#6E7781",
  keyword: "#CF222E",
  literal: "#098658",
  comment: "#6E7781"
};

const PREFIX = "lnge-sq";

function resolveOptions(optionsJson) {
  const options = Object.assign({}, DEFAULTS);

  if (optionsJson === null || optionsJson === undefined || optionsJson === "") {
    return options;
  }

  let parsed;

  try {
    parsed = JSON.parse(optionsJson);
  } catch (error) {
    /* 壊れた JSON で描画ごと落とさない。既定で描いたほうが運用上ましなので。 */
    return options;
  }

  if (!parsed || typeof parsed !== "object") {
    return options;
  }

  for (const key of Object.keys(DEFAULTS)) {
    if (parsed[key] !== undefined && parsed[key] !== null) {
      options[key] = parsed[key];
    }
  }

  if (parsed.colors && typeof parsed.colors === "object") {
    for (const key of ["hitBg", "hitBar", "markBg", "num", "numBg", "text", "border"]) {
      if (parsed.colors[key]) options[key] = parsed.colors[key];
    }
  }

  if (parsed.syntax && typeof parsed.syntax === "object") {
    for (const key of ["keyword", "literal", "comment"]) {
      if (parsed.syntax[key]) options[key] = parsed.syntax[key];
    }
  }

  if (options.mode !== "class" && options.mode !== "inline" && options.mode !== "embed") {
    options.mode = DEFAULTS.mode;
  }

  return options;
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * "line:column:length" を解析し、行番号ごとの範囲一覧へ畳む。
 *
 * 同じ箇所が経路違いで何度も渡ってくる（影響グラフは経路ごとに 1 行なので、
 * 同一の使用箇所が複数回現れる）ため、ここで重複排除と重なりの結合まで行う。
 * 範囲は [start, end) の 0 始まり列オフセットへ正規化する。
 */
function parseHighlights(highlights) {
  const byLine = new Map();

  if (!Array.isArray(highlights)) {
    return byLine;
  }

  for (const entry of highlights) {
    if (entry === null || entry === undefined) continue;

    const parts = String(entry).split(":");
    if (parts.length < 2) continue;

    const line = Number(parts[0]);
    const column = Number(parts[1]);
    const length = parts.length > 2 ? Number(parts[2]) : 0;

    if (!Number.isFinite(line) || !Number.isFinite(column)) continue;
    if (line < 1 || column < 1) continue;

    const start = column - 1;
    const end = start + (Number.isFinite(length) && length > 0 ? length : 1);

    if (!byLine.has(line)) byLine.set(line, []);
    byLine.get(line).push([start, end]);
  }

  for (const [line, ranges] of byLine) {
    ranges.sort((a, b) => (a[0] - b[0]) || (a[1] - b[1]));

    const merged = [];

    for (const range of ranges) {
      const last = merged[merged.length - 1];
      if (last && range[0] <= last[1]) {
        last[1] = Math.max(last[1], range[1]);
      } else {
        merged.push([range[0], range[1]]);
      }
    }

    byLine.set(line, merged);
  }

  return byLine;
}

/** 1 行を、ハイライト範囲で { text, hit } のセグメントへ切り分ける。 */
function segmentLine(line, ranges) {
  if (!ranges || ranges.length === 0) {
    return [{ text: line, hit: false }];
  }

  const segments = [];
  let cursor = 0;

  for (const [start, end] of ranges) {
    const from = Math.max(0, Math.min(start, line.length));
    const to = Math.max(from, Math.min(end, line.length));

    if (from > cursor) segments.push({ text: line.slice(cursor, from), hit: false });
    if (to > from) segments.push({ text: line.slice(from, to), hit: true });

    cursor = Math.max(cursor, to);
  }

  if (cursor < line.length) segments.push({ text: line.slice(cursor), hit: false });

  return segments;
}

/**
 * SQL の簡易構文ハイライト。予約語 / 文字列・数値リテラル / 行コメントのみ。
 *
 * ハイライト セグメントごとに独立して呼ぶため、語がセグメント境界で分断された場合は
 * 色が付かない。位置ハイライトを優先する意図的な割り切り。
 */
function highlightSql(source, options, styles) {
  const length = source.length;
  const isSpace = (c) => c === " " || c === "\t";
  const isDigit = (c) => c >= "0" && c <= "9";
  const isWordStart = (c) => /[A-Za-z_]/.test(c);
  const isWord = (c) => /[A-Za-z0-9_]/.test(c);

  let index = 0;
  let out = "";

  while (index < length) {
    const character = source[index];

    if (isSpace(character)) {
      let end = index + 1;
      while (end < length && isSpace(source[end])) end++;
      out += escapeHtml(source.slice(index, end));
      index = end;
      continue;
    }

    if (character === "-" && source[index + 1] === "-") {
      out += styles.comment(source.slice(index));
      break;
    }

    if (character === "'" || character === '"') {
      const quote = character;
      let end = index + 1;
      while (end < length) {
        if (source[end] === "\\") { end += 2; continue; }
        if (source[end] === quote) {
          if (source[end + 1] === quote) { end += 2; continue; }
          end++;
          break;
        }
        end++;
      }
      out += styles.literal(source.slice(index, end));
      index = end;
      continue;
    }

    if (isDigit(character)) {
      let end = index + 1;
      while (end < length && (isDigit(source[end]) || source[end] === ".")) end++;
      out += styles.literal(source.slice(index, end));
      index = end;
      continue;
    }

    if (isWordStart(character)) {
      let end = index + 1;
      while (end < length && isWord(source[end])) end++;
      const word = source.slice(index, end);
      out += SQL_KEYWORDS.has(word.toUpperCase()) ? styles.keyword(word) : escapeHtml(word);
      index = end;
      continue;
    }

    out += escapeHtml(character);
    index++;
  }

  return out;
}

/** mode に応じて、class 属性かインライン style 属性のどちらかを返す。 */
function makeAttrs(options) {
  const inline = options.mode === "inline";

  const cls = (name) => (inline ? "" : ` class="${PREFIX}-${name}"`);
  const sty = (declaration) => (inline ? ` style="${declaration}"` : "");

  return {
    root: cls("root") + sty(
      `font-family:${options.font};font-size:${options.fontSize}px;` +
      `line-height:${options.lineHeight};color:${options.text};`
    ),
    table: cls("table") + sty(
      `border-collapse:collapse;width:100%;table-layout:fixed;` +
      `border:1px solid ${options.border};`
    ),
    /* 非ハイライト行は装飾しないので属性を出さない（markup を無駄に太らせない）。 */
    row: "",
    rowHit: cls("row-hit") + sty(`background:${options.hitBg};`),
    num: cls("num") + sty(
      `width:52px;padding:0 8px;text-align:right;vertical-align:top;` +
      `color:${options.num};background:${options.numBg};` +
      `border-right:1px solid ${options.border};` +
      `user-select:none;white-space:nowrap;`
    ),
    numHit: cls("num-hit") + sty(
      `width:52px;padding:0 8px;text-align:right;vertical-align:top;` +
      `color:${options.text};background:${options.hitBg};font-weight:600;` +
      `border-right:1px solid ${options.border};` +
      `border-left:3px solid ${options.hitBar};` +
      `user-select:none;white-space:nowrap;`
    ),
    code: cls("code") + sty(
      `padding:0 10px;white-space:pre-wrap;overflow-wrap:anywhere;vertical-align:top;`
    ),
    mark: cls("mark") + sty(
      `background:${options.markBg};border-radius:2px;padding:0 1px;`
    ),
    gap: cls("gap") + sty(
      `padding:2px 10px;color:${options.gapText};background:${options.gapBg};` +
      `border-top:1px solid ${options.border};border-bottom:1px solid ${options.border};`
    ),
    keyword: (text) => `<span${cls("kw")}${sty(`color:${options.keyword};`)}>${escapeHtml(text)}</span>`,
    literal: (text) => `<span${cls("li")}${sty(`color:${options.literal};`)}>${escapeHtml(text)}</span>`,
    comment: (text) => `<span${cls("cm")}${sty(`color:${options.comment};font-style:italic;`)}>${escapeHtml(text)}</span>`
  };
}

/** class / embed モードでテンプレートに貼る CSS。inline モードでは使わない。 */
function buildUsageSqlCss(optionsJson) {
  const o = resolveOptions(optionsJson);
  const p = "." + PREFIX;

  return [
    `${p}-root{font-family:${o.font};font-size:${o.fontSize}px;line-height:${o.lineHeight};color:${o.text};}`,
    `${p}-table{border-collapse:collapse;width:100%;table-layout:fixed;border:1px solid ${o.border};}`,
    `${p}-row-hit{background:${o.hitBg};}`,
    `${p}-num{width:52px;padding:0 8px;text-align:right;vertical-align:top;color:${o.num};background:${o.numBg};border-right:1px solid ${o.border};user-select:none;white-space:nowrap;}`,
    `${p}-num-hit{width:52px;padding:0 8px;text-align:right;vertical-align:top;color:${o.text};background:${o.hitBg};font-weight:600;border-right:1px solid ${o.border};border-left:3px solid ${o.hitBar};user-select:none;white-space:nowrap;}`,
    `${p}-code{padding:0 10px;white-space:pre-wrap;overflow-wrap:anywhere;vertical-align:top;}`,
    `${p}-mark{background:${o.markBg};border-radius:2px;padding:0 1px;}`,
    `${p}-gap{padding:2px 10px;color:${o.gapText};background:${o.gapBg};border-top:1px solid ${o.border};border-bottom:1px solid ${o.border};}`,
    `${p}-kw{color:${o.keyword};}`,
    `${p}-li{color:${o.literal};}`,
    `${p}-cm{color:${o.comment};font-style:italic;}`
  ].join("\n");
}

/**
 * SQL 全文（または該当行の周辺）を、行番号つき・ハイライトつきの HTML にして返す。
 *
 * @param {string} sqlText 対象オブジェクトの SQL 本文
 * @param {Array<string>} highlights "line:column:length" の配列
 * @param {string} optionsJson 表示オプション JSON（null / '{}' で既定）
 * @returns {string} HTML。sqlText が空なら空文字
 */
function renderUsageSqlHtml(sqlText, highlights, optionsJson) {
  if (sqlText === null || sqlText === undefined || sqlText === "") {
    return "";
  }

  const options = resolveOptions(optionsJson);
  const attrs = makeAttrs(options);
  const byLine = parseHighlights(highlights);
  const lines = String(sqlText).split("\n");

  /*
   * 表示する行を決める。contextLines 未指定なら全行。指定時はハイライト行の前後
   * N 行だけを残し、飛ばした区間には「… N 行省略 …」の行を挟む。
   */
  let visible = null;

  const contextOption = options.contextLines;

  /*
   * Number(null) は 0（有限）なので、null を数値として判定してはならない。
   * 未指定を「前後 0 行」と誤読すると全文が省略されてしまう。
   */
  const hasContext =
    contextOption !== null &&
    contextOption !== undefined &&
    contextOption !== "" &&
    Number.isFinite(Number(contextOption)) &&
    Number(contextOption) >= 0;

  if (hasContext && byLine.size > 0) {
    const context = Number(options.contextLines);
    visible = new Set();

    for (const line of byLine.keys()) {
      for (let n = line - context; n <= line + context; n++) {
        if (n >= 1 && n <= lines.length) visible.add(n);
      }
    }
  }

  const rows = [];
  let rendered = 0;
  let skipped = 0;
  let truncated = false;

  const flushGap = () => {
    if (skipped > 0) {
      rows.push(`<tr><td${attrs.gap} colspan="2">… ${skipped} 行省略 …</td></tr>`);
      skipped = 0;
    }
  };

  for (let index = 0; index < lines.length; index++) {
    const lineNumber = index + 1;

    if (visible && !visible.has(lineNumber)) {
      skipped++;
      continue;
    }

    if (rendered >= options.maxLines) {
      truncated = true;
      break;
    }

    flushGap();

    const ranges = byLine.get(lineNumber);
    const isHit = Boolean(ranges && ranges.length);
    const segments = segmentLine(lines[index], ranges);

    let code = "";

    for (const segment of segments) {
      const inner = highlightSql(segment.text, options, attrs);
      code += segment.hit ? `<span${attrs.mark}>${inner}</span>` : inner;
    }

    if (code === "") code = "&nbsp;";

    rows.push(
      `<tr${isHit ? attrs.rowHit : attrs.row}>` +
      `<td${isHit ? attrs.numHit : attrs.num}>${lineNumber}</td>` +
      `<td${attrs.code}>${code}</td>` +
      `</tr>`
    );

    rendered++;
  }

  flushGap();

  if (truncated) {
    rows.push(
      `<tr><td${attrs.gap} colspan="2">` +
      `… 以降 ${lines.length - rendered} 行は maxLines (${options.maxLines}) により省略 …` +
      `</td></tr>`
    );
  }

  const body = `<div${attrs.root}><table${attrs.table}>${rows.join("")}</table></div>`;

  if (options.mode === "embed") {
    return `<style>${buildUsageSqlCss(optionsJson)}</style>${body}`;
  }

  return body;
}
''';

EXECUTE IMMEDIATE FORMAT(
  'CREATE OR REPLACE FUNCTION `%s.%s.%s`('
  || 'sql_text STRING, highlights ARRAY<STRING>, options_json STRING'
  || ') RETURNS STRING LANGUAGE js AS r"""%s',
  bootstrap_udf_project_id,
  bootstrap_udf_dataset,
  bootstrap_udf_usage_sql_html_function_name,
  usage_html_udf_js || '\nreturn renderUsageSqlHtml(sql_text, highlights, options_json);\n"""'
);

EXECUTE IMMEDIATE FORMAT(
  'CREATE OR REPLACE FUNCTION `%s.%s.%s`(options_json STRING)'
  || ' RETURNS STRING LANGUAGE js AS r"""%s',
  bootstrap_udf_project_id,
  bootstrap_udf_dataset,
  bootstrap_udf_usage_sql_css_function_name,
  usage_html_udf_js || '\nreturn buildUsageSqlCss(options_json);\n"""'
);
-- END GENERATED: usage SQL HTML UDF

-- ============================================================================
-- 4a. Repository views -- always recreated (CREATE OR REPLACE VIEW is safe)
-- ============================================================================

-- Column-usage x impact depth view. Joins the usage index to the impact graph so
-- a report can pick an ORIGIN column and see every downstream usage site with a
-- DEPTH (relative to that origin: 1 = direct reference, impact_rank + 1 deeper)
-- and the value-flow path. Depth is origin-relative -- the same usage site sits
-- at different depths for different origins -- so it is a view (computed per
-- (origin, usage-site) on read), never a stored rank on the usage table. Impact
-- is fully replaced each 03 STEP 4 run, so the view always holds the current
-- snapshot with no snapshot filter. Created here, after the tables it reads
-- (lnge_t_column_usage / lnge_t_impact).
EXECUTE IMMEDIATE FORMAT(
  '''
  CREATE OR REPLACE VIEW `%s.%s`
  OPTIONS (
    description = 'Column usage joined to impact: for a chosen origin column, every downstream usage site with a depth (1 = direct reference; impact_rank + 1 deeper) and the value-flow path. Locating a reference: line_number, then word_number (1-based index of the whitespace-delimited word holding it -- unaffected by indentation) or column_number (1-based CHARACTER position in the original line, indentation included, a tab counting as one). line_text has its leading indentation stripped; line_indent_width is how much was removed, so the character position within it is column_number - line_indent_width. usage_definition_text is the full SQL of the object containing the reference, returned only while the registry still holds the analyzed definition (usage_definition_is_current).'
  )
  AS
  -- Per-usage location and definition lookup, computed once and reused by both
  -- depth branches below. Splitting it out keeps the word/column arithmetic in one
  -- place instead of repeating it per branch.
  --
  -- The registry join is on the usage object's KEY (project/dataset/name/type),
  -- which is the registry's own MERGE key -- exactly one row per object, so no
  -- fan-out. Joining on definition_hash alone would multiply rows whenever two
  -- objects happen to share identical SQL, since the hash is of the text.
  WITH usage_words AS (
    SELECT
      u.*,
      d.definition_hash AS registry_definition_hash,
      d.definition_text AS registry_definition_text,
      -- word_number: which whitespace-delimited word of the line the reference sits
      -- in. column_number counts every character including the indentation, which is
      -- awkward to verify by eye; counting words is how a person actually finds the
      -- spot. Words before the reference are counted, then 1 is added when the
      -- reference starts a new word (nothing before it on the line, or the character
      -- before it is whitespace). When it does NOT -- `a.col`, `f(col)` -- the
      -- reference is part of the word already counted, so no increment: `col` in
      -- `SELECT a.col` is word 2, the word `a.col`.
      CASE
        WHEN u.line_text IS NULL OR u.column_number IS NULL THEN NULL
        ELSE
          ARRAY_LENGTH(
            REGEXP_EXTRACT_ALL(SUBSTR(u.line_text, 1, u.column_number - 1), r'\\S+')
          )
          + IF(
              SUBSTR(u.line_text, 1, u.column_number - 1) = ''
              OR REGEXP_CONTAINS(SUBSTR(u.line_text, 1, u.column_number - 1), r'\\s$'),
              1,
              0
            )
      END AS word_number
    FROM `%s.%s` AS u
    LEFT JOIN `%s.%s` AS d
      ON  LOWER(d.object_project) = LOWER(u.object_project)
      AND LOWER(d.object_dataset) = LOWER(u.object_dataset)
      AND LOWER(d.object_name)    = LOWER(u.object_name)
      AND d.object_type           = u.object_type
  ),
  usage_located AS (
    SELECT
      w.*,
      -- The word itself, so word_number can be confirmed without opening the SQL.
      -- Guarded rather than relying on a NULL offset behaving as a NULL element.
      IF(
        w.word_number IS NULL,
        NULL,
        REGEXP_EXTRACT_ALL(w.line_text, r'\\S+')[SAFE_OFFSET(w.word_number - 1)]
      ) AS word_text
    FROM usage_words AS w
  ),
  -- 2 つの depth ブランチ。最終 SELECT でハイライト集約と HTML 生成を足す。
  impact_rows AS (
  -- depth = 1: the usage references the origin column directly.
  SELECT
    u.source_project      AS origin_project,
    u.source_dataset      AS origin_dataset,
    u.source_object       AS origin_object,
    u.source_object_type  AS origin_object_type,
    u.source_column       AS origin_column,
    1                     AS depth,
    u.source_project      AS ref_source_project,
    u.source_dataset      AS ref_source_dataset,
    u.source_object       AS ref_source_object,
    u.source_object_type  AS ref_source_object_type,
    u.source_column       AS ref_source_column,
    u.source_field_path   AS ref_source_field_path,
    u.object_project      AS usage_object_project,
    u.object_dataset      AS usage_object_dataset,
    u.object_name         AS usage_object_name,
    u.object_type         AS usage_object_type,
    u.generation_type     AS usage_generation_type,
    -- definition_hash of the object that CONTAINS the reference. Use it as the key
    -- to pull that object's actual SQL (e.g. from lnge_m_definition_registry)
    -- when the metadata + line number are not enough to understand the usage.
    u.definition_hash     AS usage_definition_hash,
    u.usage_type,
    u.reference_name,
    u.line_number,
    u.word_number,
    u.word_text,
    -- Position in the ORIGINAL line, indentation included, so it stays valid
    -- against the object's stored definition text.
    u.column_number,
    LTRIM(u.line_text) AS line_text,
    LENGTH(u.line_text) - LENGTH(LTRIM(u.line_text)) AS line_indent_width,
    u.resolution_status,
    -- Returned only when the registry still holds the very definition that was
    -- analyzed: after a redefinition its text is a DIFFERENT SQL whose line numbers
    -- would not line up, so NULL beats something plausible but wrong.
    CASE
      WHEN u.registry_definition_hash = u.definition_hash
        THEN u.registry_definition_text
    END AS usage_definition_text,
    (u.registry_definition_hash = u.definition_hash) AS usage_definition_is_current,
    CAST(NULL AS ARRAY<STRING>) AS dependency_path
  FROM usage_located AS u
  UNION ALL
  -- depth = impact_rank + 1: the usage references a column impacted by the origin.
  SELECT
    i.origin_project,
    i.origin_dataset,
    i.origin_object,
    i.origin_object_type,
    i.origin_column,
    i.impact_rank + 1     AS depth,
    u.source_project      AS ref_source_project,
    u.source_dataset      AS ref_source_dataset,
    u.source_object       AS ref_source_object,
    u.source_object_type  AS ref_source_object_type,
    u.source_column       AS ref_source_column,
    u.source_field_path   AS ref_source_field_path,
    u.object_project      AS usage_object_project,
    u.object_dataset      AS usage_object_dataset,
    u.object_name         AS usage_object_name,
    u.object_type         AS usage_object_type,
    u.generation_type     AS usage_generation_type,
    u.definition_hash     AS usage_definition_hash,
    u.usage_type,
    u.reference_name,
    u.line_number,
    u.word_number,
    u.word_text,
    u.column_number,
    LTRIM(u.line_text) AS line_text,
    LENGTH(u.line_text) - LENGTH(LTRIM(u.line_text)) AS line_indent_width,
    u.resolution_status,
    CASE
      WHEN u.registry_definition_hash = u.definition_hash
        THEN u.registry_definition_text
    END AS usage_definition_text,
    (u.registry_definition_hash = u.definition_hash) AS usage_definition_is_current,
    i.dependency_path
  FROM `%s.%s` AS i
  JOIN usage_located AS u
    ON  LOWER(u.source_project) = LOWER(i.impacted_project)
    AND LOWER(u.source_dataset) = LOWER(i.impacted_dataset)
    AND LOWER(u.source_object)  = LOWER(i.impacted_object)
    AND LOWER(u.source_column)  = LOWER(i.impacted_column)
  )
  SELECT
    r.*,
    -- 使用箇所つき SQL の HTML。Looker Studio の Templated Record に渡して描画する。
    --
    -- ハイライト位置は「同じ起点カラム × 同じオブジェクト × 同じ定義」の行を
    -- 分析関数でまとめて集める。分析関数は WHERE の後に評価されるので、レポートが
    -- 起点カラムで絞り込めば、その起点に関係する箇所だけが集まる。1 レコードを表示する
    -- Templated Record では、その 1 件の SQL 上に関連箇所が全部ハイライトされる。
    --
    -- 経路違いで同じ箇所が何度も入るが、重複と重なりの結合は UDF 側で行う。
    -- line_number / column_number が無い行は空文字にしておき、UDF が読み飛ばす。
    `%s.%s.%s`(
      r.usage_definition_text,
      ARRAY_AGG(
        CASE
          WHEN r.line_number IS NOT NULL AND r.column_number IS NOT NULL
            THEN FORMAT(
              '%%d:%%d:%%d',
              r.line_number,
              r.column_number,
              GREATEST(LENGTH(COALESCE(r.reference_name, '')), 1)
            )
          ELSE ''
        END
      ) OVER (
        PARTITION BY
          r.origin_project, r.origin_dataset, r.origin_object,
          r.origin_object_type, r.origin_column,
          r.usage_object_project, r.usage_object_dataset,
          r.usage_object_name, r.usage_object_type,
          r.usage_definition_hash
      ),
      NULL
    ) AS usage_definition_html
  FROM impact_rows AS r
  ''',
  -- Argument order follows the %s placeholders in text order: CREATE VIEW target,
  -- usage table, definition registry, impact table, HTML UDF.
  -- HTML UDF は他の UDF と同じく bootstrap_udf_dataset 側にあるため 3 部構成。
  repository_dataset_full_name, view_column_usage_impact,
  repository_dataset_full_name, table_column_usage,
  repository_dataset_full_name, table_definition_registry,
  repository_dataset_full_name, table_impact,
  bootstrap_udf_project_id, bootstrap_udf_dataset,
  bootstrap_udf_usage_sql_html_function_name
);

-- Object (table/view) level dependency view. Rolls the column-level impact graph
-- up to one row per (origin object -> impacted object) pair, keeping the
-- TRANSITIVE reach: impact_rank is the shortest hop count between the two
-- objects (1 = direct reference), so a report can draw the whole downstream tree
-- of an object without touching columns. The column detail is kept as an
-- ARRAY<STRUCT> (column_dependencies) plus, because Looker Studio cannot consume
-- ARRAY columns, a flattened STRING rendering of the same content
-- (column_dependencies_text / origin_columns_text / impacted_columns_text /
-- shortest_object_path_text).
--
-- Scope: rows are restricted to what the 03 pipeline actually analyzed. Objects
-- whose registry row is EPHEMERAL (the synthetic fp_<hash> identities used to
-- collapse temp/rotating destinations), INACTIVE, or whose analysis did not end
-- in COMPLETED / COMPLETED_WITH_WARNINGS are dropped from BOTH endpoints. A path
-- that merely PASSES THROUGH an excluded object survives: lnge_t_impact stores
-- one row per origin/impacted pair with the intermediate nodes only inside
-- dependency_path, so the end-to-end reach is preserved at its true rank.
-- Upstream objects that are referenced but never analyzed themselves (raw source
-- tables) have no registry row; they are kept and flagged with
-- origin_is_analysis_target = FALSE, since dropping them would remove every edge
-- that enters the analyzed area from outside.
--
-- Impact is fully replaced by each 03 STEP 4 run, so there is no snapshot filter;
-- snapshot_at is carried through only so a report can show the data's age.
EXECUTE IMMEDIATE FORMAT(
  '''
  CREATE OR REPLACE VIEW `%s.%s`
  OPTIONS (
    description = 'Object-level (table/view) transitive dependency graph, aggregated from the column-level impact paths. One row per origin object -> impacted object pair; impact_rank is the shortest hop count (1 = direct reference). Column detail is carried both as an ARRAY<STRUCT> (column_dependencies) and as flattened STRING columns for Looker Studio, which cannot read ARRAY columns. Ephemeral, inactive and non-COMPLETED objects are excluded from both endpoints, so only the objects the pipeline actually analyzed appear; paths passing through an excluded object are still reported end to end. Objects that are referenced but never analyzed (raw sources) are kept with origin_is_analysis_target = FALSE.'
  )
  AS
  -- One row per object key, so the two LEFT JOINs below cannot fan out even if the
  -- registry ever held the same name under two object_types. object_type is NOT a
  -- join key for the same reason: the impact row carries the type the analyzer saw
  -- for that reference, which need not match the registry's.
  WITH registry AS (
    SELECT
      LOWER(object_project) AS object_project,
      LOWER(object_dataset) AS object_dataset,
      LOWER(object_name)    AS object_name,
      ANY_VALUE(generation_type) AS generation_type,
      LOGICAL_OR(COALESCE(is_ephemeral, FALSE)) AS is_ephemeral,
      LOGICAL_OR(COALESCE(is_active, FALSE))    AS is_active,
      LOGICAL_OR(analysis_status IN ('COMPLETED', 'COMPLETED_WITH_WARNINGS'))
        AS is_analyzed
    FROM `%s.%s`
    GROUP BY 1, 2, 3
  ),
  -- Impact rows narrowed to the analyzed scope. An endpoint with no registry row
  -- is an upstream source that was never an analysis target: kept, and marked as
  -- such. An endpoint WITH a registry row must be a live, successfully analyzed,
  -- non-ephemeral object.
  scoped_impact AS (
    SELECT
      i.snapshot_at,
      i.origin_project,
      i.origin_dataset,
      i.origin_object,
      i.origin_object_type,
      i.origin_column,
      i.impacted_project,
      i.impacted_dataset,
      i.impacted_object,
      i.impacted_object_type,
      i.impacted_column,
      i.impact_rank,
      i.path_hash,
      i.dependency_path,
      i.is_cycle,
      i.resolution_status,
      ro.generation_type AS origin_generation_type,
      ri.generation_type AS impacted_generation_type,
      (ro.object_name IS NOT NULL) AS origin_is_analysis_target,
      (ri.object_name IS NOT NULL) AS impacted_is_analysis_target
    FROM `%s.%s` AS i
    LEFT JOIN registry AS ro
      ON  ro.object_project = LOWER(i.origin_project)
      AND ro.object_dataset = LOWER(i.origin_dataset)
      AND ro.object_name    = LOWER(i.origin_object)
    LEFT JOIN registry AS ri
      ON  ri.object_project = LOWER(i.impacted_project)
      AND ri.object_dataset = LOWER(i.impacted_dataset)
      AND ri.object_name    = LOWER(i.impacted_object)
    WHERE COALESCE(ro.is_ephemeral, FALSE) = FALSE
      AND COALESCE(ri.is_ephemeral, FALSE) = FALSE
      AND (ro.object_name IS NULL OR (ro.is_active AND ro.is_analyzed))
      AND (ri.object_name IS NULL OR (ri.is_active AND ri.is_analyzed))
  ),
  -- Collapse the paths to column grain first. lnge_t_impact holds one row per
  -- distinct PATH, so the same (origin column -> impacted column) pair appears once
  -- per route; aggregating here is what keeps the ARRAY below free of duplicates.
  -- A NULL column (a star reference) is rendered as '*' so it groups and displays.
  column_pairs AS (
    SELECT
      origin_project,
      origin_dataset,
      origin_object,
      origin_object_type,
      origin_generation_type,
      origin_is_analysis_target,
      impacted_project,
      impacted_dataset,
      impacted_object,
      impacted_object_type,
      impacted_generation_type,
      impacted_is_analysis_target,
      COALESCE(origin_column, '*')   AS origin_column,
      COALESCE(impacted_column, '*') AS impacted_column,
      MIN(impact_rank)               AS column_impact_rank,
      COUNT(DISTINCT path_hash)      AS column_path_count,
      LOGICAL_OR(is_cycle)           AS column_has_cycle_path,
      LOGICAL_AND(resolution_status = 'RESOLVED') AS column_is_fully_resolved,
      STRING_AGG(DISTINCT resolution_status, ', ' ORDER BY resolution_status)
        AS column_resolution_statuses,
      MAX(snapshot_at) AS snapshot_at,
      -- Shortest route for this column pair. Wrapped in a STRUCT because an ARRAY
      -- cannot hold an ARRAY directly; the field is read back below.
      ARRAY_AGG(
        STRUCT(dependency_path AS path)
        ORDER BY impact_rank, path_hash
        LIMIT 1
      )[OFFSET(0)].path AS shortest_column_path
    FROM scoped_impact
    GROUP BY 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14
  ),
  -- Roll up to object grain.
  object_pairs AS (
    SELECT
      origin_project,
      origin_dataset,
      origin_object,
      origin_object_type,
      origin_generation_type,
      origin_is_analysis_target,
      impacted_project,
      impacted_dataset,
      impacted_object,
      impacted_object_type,
      impacted_generation_type,
      impacted_is_analysis_target,
      MAX(snapshot_at)          AS snapshot_at,
      MIN(column_impact_rank)   AS impact_rank,
      MAX(column_impact_rank)   AS max_impact_rank,
      SUM(column_path_count)    AS path_count,
      COUNT(*)                  AS column_pair_count,
      COUNT(DISTINCT origin_column)   AS origin_column_count,
      COUNT(DISTINCT impacted_column) AS impacted_column_count,
      LOGICAL_OR(column_has_cycle_path)     AS has_cycle_path,
      LOGICAL_AND(column_is_fully_resolved) AS is_fully_resolved,
      ARRAY_AGG(
        STRUCT(
          origin_column,
          impacted_column,
          column_impact_rank         AS impact_rank,
          column_path_count          AS path_count,
          column_resolution_statuses AS resolution_statuses
        )
        ORDER BY origin_column, impacted_column
      ) AS column_dependencies,
      -- Flattened renderings: Looker Studio cannot read ARRAY columns, so the same
      -- content is offered as text. One line per column pair; wrap the field in a
      -- <pre> (or a Templated Record) to keep the line breaks.
      STRING_AGG(
        FORMAT('%%s -> %%s (rank %%d)', origin_column, impacted_column, column_impact_rank),
        '\\n' ORDER BY origin_column, impacted_column
      ) AS column_dependencies_text,
      STRING_AGG(DISTINCT origin_column, ', ' ORDER BY origin_column)
        AS origin_columns_text,
      STRING_AGG(DISTINCT impacted_column, ', ' ORDER BY impacted_column)
        AS impacted_columns_text,
      -- The route of the shortest column pair represents the object pair.
      ARRAY_AGG(
        STRUCT(shortest_column_path AS path)
        ORDER BY column_impact_rank, origin_column, impacted_column
        LIMIT 1
      )[OFFSET(0)].path AS shortest_column_path
    FROM column_pairs
    GROUP BY 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12
  ),
  -- dependency_path elements are 'project.dataset.object.column'. Drop the trailing
  -- column segment to get the object route, then remove consecutive duplicates --
  -- several columns of the same object in a row collapse to one hop.
  object_pairs_pathed AS (
    SELECT
      p.* EXCEPT (shortest_column_path),
      ARRAY(
        SELECT REGEXP_REPLACE(element, r'\\.[^.]*$', '')
        FROM UNNEST(p.shortest_column_path) AS element WITH OFFSET AS element_offset
        WHERE element_offset = 0
           OR REGEXP_REPLACE(element, r'\\.[^.]*$', '')
              <> REGEXP_REPLACE(
                   p.shortest_column_path[OFFSET(element_offset - 1)],
                   r'\\.[^.]*$',
                   ''
                 )
        ORDER BY element_offset
      ) AS shortest_object_path
    FROM object_pairs AS p
  )
  SELECT
    q.snapshot_at,
    q.origin_project,
    q.origin_dataset,
    q.origin_object,
    q.origin_object_type,
    q.origin_generation_type,
    q.origin_is_analysis_target,
    CONCAT(
      COALESCE(q.origin_project, ''), '.',
      COALESCE(q.origin_dataset, ''), '.',
      q.origin_object
    ) AS origin_full_name,
    q.impacted_project,
    q.impacted_dataset,
    q.impacted_object,
    q.impacted_object_type,
    q.impacted_generation_type,
    q.impacted_is_analysis_target,
    CONCAT(
      COALESCE(q.impacted_project, ''), '.',
      COALESCE(q.impacted_dataset, ''), '.',
      q.impacted_object
    ) AS impacted_full_name,
    q.impact_rank,
    q.max_impact_rank,
    (q.impact_rank = 1) AS is_direct,
    q.path_count,
    q.column_pair_count,
    q.origin_column_count,
    q.impacted_column_count,
    q.has_cycle_path,
    q.is_fully_resolved,
    q.column_dependencies,
    q.column_dependencies_text,
    q.origin_columns_text,
    q.impacted_columns_text,
    q.shortest_object_path,
    ARRAY_TO_STRING(q.shortest_object_path, ' -> ') AS shortest_object_path_text
  FROM object_pairs_pathed AS q
  ''',
  -- Argument order follows the %s placeholders in text order: CREATE VIEW target,
  -- definition registry, impact table.
  repository_dataset_full_name, view_object_dependency,
  repository_dataset_full_name, table_definition_registry,
  repository_dataset_full_name, table_impact
);

IF NOT recreate_views_only THEN

-- ============================================================================
-- 4b. Persistent dynamic-SQL renderer
--
-- lnge_render_dynamic_sql expands the __TARGET_PROJECT__ / __JOB_REGION__ / __UDF__
-- / __T_*__ identifier placeholders used by 03's dynamic SQL templates. It was
-- formerly a script-level TEMP FUNCTION inside 03, but BigQuery prepends every
-- script TEMP FUNCTION's DDL to the query text of every child job, so the
-- console's "All results" list showed only "create temp function
-- lnge_render_dynamic_sql(" for each statement. Deploying it as a persistent function
-- here removes that prepend, so each statement (and the per-step progress
-- markers) shows its own SQL. The function is created in the UDF dataset,
-- alongside lnge_analyze_json (bootstrap_udf_project_id /
-- bootstrap_udf_dataset). 03 invokes it dynamically using its udf_project_id /
-- udf_dataset DECLAREs, so keep this deployment location in step with those.
-- ============================================================================
EXECUTE IMMEDIATE FORMAT(
  '''
  CREATE OR REPLACE FUNCTION `%s.%s.%s`(
    sql_template STRING,
    repository_project_id STRING,
    repository_dataset STRING,
    target_project_id STRING,
    job_region STRING,
    udf_project_id STRING,
    udf_dataset STRING,
    udf_function_name STRING,
    repo_tables STRUCT<
      def_registry STRING,
      direct_dep STRING,
      impact STRING,
      diagnostic STRING,
      job_registry STRING
    >
  )
  RETURNS STRING
  AS (
    REPLACE(
    REPLACE(
    REPLACE(
      REPLACE(
        REPLACE(
          REPLACE(
            REPLACE(
              REPLACE(
                sql_template,
                '__TARGET_PROJECT__',
                target_project_id
          ),
          '__JOB_REGION__',
          job_region
        ),
        '__UDF__',
        udf_project_id || '.' || udf_dataset || '.' || udf_function_name
      ),
      '__T_DEF_REGISTRY__',
      repository_project_id || '.' || repository_dataset || '.'
        || repo_tables.def_registry
    ),
      '__T_DIRECT_DEP__',
      repository_project_id || '.' || repository_dataset || '.'
        || repo_tables.direct_dep
    ),
      '__T_IMPACT__',
      repository_project_id || '.' || repository_dataset || '.'
        || repo_tables.impact
    ),
      '__T_DIAGNOSTIC__',
      repository_project_id || '.' || repository_dataset || '.'
        || repo_tables.diagnostic
    ),
      '__T_JOB_REGISTRY__',
      repository_project_id || '.' || repository_dataset || '.'
        || repo_tables.job_registry
    )
  )
  ''',
  bootstrap_udf_project_id,
  bootstrap_udf_dataset,
  bootstrap_udf_render_function_name
);

-- ============================================================================
-- 5. Persistent JavaScript UDF using the external GCS bundle
--
-- Dataset (SCHEMA) creation for the UDF dataset is intentionally disabled. The
-- UDF dataset is expected to already exist; this setup script only
-- creates/replaces the function within it. Uncomment the block below to have
-- the script create the dataset.
-- ============================================================================
-- EXECUTE IMMEDIATE FORMAT(
--   '''
--   CREATE SCHEMA IF NOT EXISTS `%s.%s`
--   OPTIONS (
--     location = '%s'
--   )
--   ''',
--   bootstrap_udf_project_id,
--   bootstrap_udf_dataset,
--   bootstrap_repository_location
-- );

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
  bootstrap_udf_project_id,
  bootstrap_udf_dataset,
  bootstrap_udf_function_name,
  bootstrap_udf_library_uri
);

-- Companion fingerprint UDF (same library bundle). Returns a literal-normalized
-- canonical SQL string; the pipeline hashes it with SHA256 to group
-- structurally-identical SELECT jobs.
EXECUTE IMMEDIATE FORMAT(
  '''
  CREATE OR REPLACE FUNCTION `%s.%s.%s`(
    sql_text STRING
  )
  RETURNS STRING
  LANGUAGE js
  OPTIONS (
    library = [
      '%s'
    ]
  )
  AS r"""
    return fingerprintSqlForBigQuery(sql_text);
  """
  ''',
  bootstrap_udf_project_id,
  bootstrap_udf_dataset,
  bootstrap_udf_fingerprint_function_name,
  bootstrap_udf_library_uri
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
  bootstrap_udf_project_id,
  bootstrap_udf_dataset,
  bootstrap_udf_function_name,
  bootstrap_target_project_id,
  bootstrap_target_datasets[SAFE_OFFSET(0)]
)
INTO smoke_test_result
USING
  bootstrap_parser_strict_mode AS strict_mode,
  bootstrap_compact_export AS compact_export,
  bootstrap_target_project_id AS target_project_id,
  bootstrap_target_datasets[SAFE_OFFSET(0)] AS target_dataset;

SET smoke_test_status = COALESCE(
  JSON_VALUE(smoke_test_result, '$.analysis.analysis_status'),
  'UNKNOWN'
);

ASSERT smoke_test_status IN (
  'COMPLETED',
  'COMPLETED_WITH_WARNINGS'
)
AS 'Persistent lineage UDF smoke test did not complete successfully.';

-- Fingerprint UDF smoke test: two SELECTs differing only in a literal must
-- produce the same fingerprint, and a structurally different SELECT must not.
EXECUTE IMMEDIATE FORMAT(
  '''
  SELECT
    `%s.%s.%s`('SELECT a FROM t WHERE d = 1')
      = `%s.%s.%s`('SELECT a FROM t WHERE d = 2')
    AND `%s.%s.%s`('SELECT a FROM t WHERE d = 1')
      != `%s.%s.%s`('SELECT a, b FROM t WHERE d = 1')
  ''',
  bootstrap_udf_project_id, bootstrap_udf_dataset,
  bootstrap_udf_fingerprint_function_name,
  bootstrap_udf_project_id, bootstrap_udf_dataset,
  bootstrap_udf_fingerprint_function_name,
  bootstrap_udf_project_id, bootstrap_udf_dataset,
  bootstrap_udf_fingerprint_function_name,
  bootstrap_udf_project_id, bootstrap_udf_dataset,
  bootstrap_udf_fingerprint_function_name
)
INTO fingerprint_smoke_result;

ASSERT fingerprint_smoke_result
AS 'Persistent fingerprint UDF smoke test did not behave as expected.';

END IF;  -- NOT recreate_views_only (sections 4b/5/6: renderer, UDF, smoke tests)

-- ============================================================================
-- 7. Setup summary
-- ============================================================================
SELECT
  bootstrap_default_project_id AS project_id,
  bootstrap_project_token AS project_token,
  FORMAT(
    '%s.%s',
    bootstrap_repository_project_id,
    bootstrap_repository_dataset
  ) AS repository_dataset,
  bootstrap_repository_location,
  FORMAT(
    '%s.%s.%s',
    bootstrap_udf_project_id,
    bootstrap_udf_dataset,
    bootstrap_udf_function_name
  ) AS persistent_udf,
  FORMAT(
    '%s.%s.%s',
    bootstrap_udf_project_id,
    bootstrap_udf_dataset,
    bootstrap_udf_fingerprint_function_name
  ) AS fingerprint_udf,
  FORMAT(
    '%s.%s.%s',
    bootstrap_udf_project_id,
    bootstrap_udf_dataset,
    bootstrap_udf_render_function_name
  ) AS render_udf,
  bootstrap_udf_library_uri,
  bootstrap_target_project_id,
  bootstrap_target_datasets,
  bootstrap_parser_strict_mode,
  bootstrap_compact_export,
  -- NULL on a views-only run: the smoke tests live in the section that run skips.
  smoke_test_status,
  recreate_views_only AS views_only_run,
  CURRENT_TIMESTAMP() AS setup_finished_at;
