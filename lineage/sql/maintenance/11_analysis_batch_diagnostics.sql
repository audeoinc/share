-- ============================================================================
-- 11_analysis_batch_diagnostics.sql
-- BigQuery Physical Lineage Repository - STEP 3 batch diagnostics (from JOBS)
-- ============================================================================
-- Reads INFORMATION_SCHEMA.JOBS to answer two questions after a 03 run that died
-- in STEP 3, without hunting through the console's per-statement result list.
--
--   Report 1  Where did 03 report each batch's payload size?
--             03 emits an ANALYSIS_BATCH_PAYLOAD row immediately BEFORE each
--             analysis UDF call, so when that call aborts the script the last such
--             row describes the batch that failed. The dataset and batch number are
--             inlined into that statement's SQL text, so they are pulled out here as
--             columns -- the byte counts still need the job's own result, and the
--             job_id column is what to open in the console's job history to see it.
--
--   Report 2  Which statement actually failed, and with what error?
--             "Resource exceeded during query execution: UDF out of memory" shows up
--             here against the CREATE OR REPLACE TEMP TABLE batch_udf_results
--             statement. Pair it with report 1's last row to get "this batch, this
--             size, this error".
--
-- Read-only; touches no repository table. Run it on demand right after a failed 03.
--
-- SCOPE: JOBS_BY_PROJECT covers jobs run in THIS project by any user. If 03 runs
-- under a service account in another project, set jobs_project_id below to that
-- project (the caller needs job metadata access there).
--
-- RETENTION: INFORMATION_SCHEMA.JOBS keeps roughly 180 days, but query results
-- themselves expire much sooner (~24h for the anonymous result table). Past that,
-- report 1 still names the batch but its numbers are gone -- re-run 03 to regenerate.
-- ============================================================================
SET @@location = 'asia-northeast1';

BEGIN
  -- --------------------------------------------------------------------------
  -- [A] REQUIRED per deployment / region -- set these
  -- --------------------------------------------------------------------------
  -- Nothing is required for this script: it reads only INFORMATION_SCHEMA.JOBS in
  -- the running project and region. The region comes from `SET @@location` at the
  -- top of the file; the project is auto-detected in [C]. To read another project's
  -- jobs, pin jobs_project_id in [C].

  -- --------------------------------------------------------------------------
  -- [B] BEHAVIOR OPTIONS -- defaults are safe; tune as needed
  -- --------------------------------------------------------------------------
  -- GCP project. Declared here (not in [A]) because it is normally not set by hand:
  -- it is auto-detected in [C] from INFORMATION_SCHEMA.SCHEMATA (the project the job
  -- runs in). To pin it, set a literal in [C].
  DECLARE default_project_id STRING;
  -- How far back to look. Widen it if the failed run was a while ago; note the
  -- result-retention caveat in the header before going much past a day.
  DECLARE lookback_hours INT64 DEFAULT 3;
  -- Rows per report.
  DECLARE row_limit INT64 DEFAULT 20;

  -- --------------------------------------------------------------------------
  -- [C] DERIVED / INTERNAL -- from [A]/[B]; DO NOT edit
  -- --------------------------------------------------------------------------
  -- Whose jobs to read. Takes default_project_id (auto-detected below); pin it to a
  -- literal to inspect a run that happened in another project.
  DECLARE jobs_project_id STRING DEFAULT NULL;
  DECLARE rendered_sql STRING;

  -- Auto-detect the running GCP project from INFORMATION_SCHEMA.SCHEMATA
  -- (catalog_name). The region-qualified identifier is built from @@location.
  EXECUTE IMMEDIATE FORMAT(
    "SELECT DISTINCT catalog_name FROM `region-%s`.INFORMATION_SCHEMA.SCHEMATA LIMIT 1",
    @@location
  ) INTO default_project_id;
  ASSERT default_project_id IS NOT NULL AS
    'Could not auto-detect the project id from INFORMATION_SCHEMA.SCHEMATA; set default_project_id to a literal.';
  SET jobs_project_id = COALESCE(jobs_project_id, default_project_id);

  ASSERT lookback_hours >= 1 AS 'lookback_hours must be >= 1.';
  ASSERT row_limit >= 1 AS 'row_limit must be >= 1.';

  -- --------------------------------------------------------------------------
  -- Report 1: the ANALYSIS_BATCH_PAYLOAD statements, newest first.
  --
  -- The newest row is the batch that was about to be analyzed when the run ended --
  -- i.e. the one that failed. dataset / batch_no are parsed out of the statement's
  -- own SQL text (03 inlines them with FORMAT), so the batch is identified without
  -- opening anything. Open job_id in the console's job history for the byte counts.
  --
  -- The regexes avoid backslash escapes on purpose (POSIX classes and plain
  -- character sets), so the pattern survives being embedded in this string.
  -- --------------------------------------------------------------------------
  SET rendered_sql = FORMAT(
    """
    SELECT
      job_id,
      creation_time,
      REGEXP_EXTRACT(query, "'([^']*)' AS dataset") AS dataset,
      CAST(REGEXP_EXTRACT(query, "([0-9]+) AS batch_no") AS INT64) AS batch_no,
      state,
      error_result.message AS error_message,
      SUBSTR(REGEXP_REPLACE(query, "[[:space:]]+", " "), 1, 200) AS query_head
    FROM `%s.region-%s`.INFORMATION_SCHEMA.JOBS_BY_PROJECT
    WHERE creation_time > TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL @hours HOUR)
      AND query LIKE '%%ANALYSIS_BATCH_PAYLOAD%%'
      -- The statement that DEFINES the notice, not this diagnostic script reading it.
      AND query NOT LIKE '%%INFORMATION_SCHEMA.JOBS%%'
    ORDER BY creation_time DESC
    LIMIT @max_rows
    """,
    jobs_project_id,
    @@location
  );

  EXECUTE IMMEDIATE rendered_sql
  USING lookback_hours AS hours, row_limit AS max_rows;

  -- --------------------------------------------------------------------------
  -- Report 2: failed statements in the same window.
  --
  -- A STEP 3 out-of-memory appears against batch_udf_results. Everything else that
  -- failed in the window is listed too, so an unrelated failure is not mistaken for
  -- this one.
  -- --------------------------------------------------------------------------
  SET rendered_sql = FORMAT(
    """
    SELECT
      job_id,
      parent_job_id,
      creation_time,
      TIMESTAMP_DIFF(end_time, start_time, SECOND) AS elapsed_sec,
      error_result.reason AS error_reason,
      error_result.message AS error_message,
      SUBSTR(REGEXP_REPLACE(query, "[[:space:]]+", " "), 1, 200) AS query_head
    FROM `%s.region-%s`.INFORMATION_SCHEMA.JOBS_BY_PROJECT
    WHERE creation_time > TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL @hours HOUR)
      AND error_result IS NOT NULL
      AND query IS NOT NULL
    ORDER BY creation_time DESC
    LIMIT @max_rows
    """,
    jobs_project_id,
    @@location
  );

  EXECUTE IMMEDIATE rendered_sql
  USING lookback_hours AS hours, row_limit AS max_rows;
END;
