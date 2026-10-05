-- ============================================================================
-- 11_analysis_batch_diagnostics.sql
-- BigQuery Physical Lineage Repository - STEP 3 batch diagnostics (from JOBS)
-- ============================================================================
-- Reads INFORMATION_SCHEMA.JOBS to answer two questions about a 03 run's STEP 3 --
-- how long each batch took, and which statement failed if one did -- without hunting
-- through the console's per-statement result list.
--
--   Report 1  How long did each batch take, and how big was its payload?
--             03 emits an ANALYSIS_BATCH_PAYLOAD row immediately BEFORE each
--             analysis UDF call, so when that call aborts the script the last such
--             row describes the batch that failed. The dataset and batch number are
--             inlined into that statement's SQL text, so they are pulled out here as
--             columns, and batch_seconds is the gap to the NEXT notice -- that is,
--             how long the batch between them took. The payload byte counts still
--             need the job's own result: job_id is what to open in job history.
--
--   Report 3  Where did the run's time go? Every statement, slowest first, with
--             wall time against slot time -- which separates "waiting for a job to
--             start" from "doing work", and so says whether to run fewer statements
--             or write better ones.
--
--   Report 4  The same time grouped into the phases of a run (STEP 1/2/3/4), so the
--             next thing to optimize is chosen from a share of the clock rather than
--             a guess. Labels are matched from SQL text: a heuristic, good enough to
--             rank phases and not to audit them.
--
--   Report 5  Which statement SHAPES ran many times. The cheapest statements hide
--             from reports 3 and 4, and when a run's cost is its statement count,
--             those are exactly the ones worth finding: a 0.1s statement run a
--             hundred times costs more than a 14-second query.
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
  -- Report 2 lists every failed job in the window, which in a shared project is
  -- mostly other people's work. TRUE keeps only statements that touch this system
  -- (their SQL names an lnge_ object or one of STEP 3's staging tables), so an
  -- unrelated access-denied or invalid-query failure is not mistaken for a 03
  -- problem. Set FALSE to see everything that failed.
  DECLARE lineage_statements_only BOOL DEFAULT TRUE;
  -- Which RUN to report on. A lookback window usually spans several 03 runs, and
  -- mixing them makes every total meaningless -- a phase breakdown over three runs
  -- says nothing about any of them.
  --
  -- Left NULL, [C] finds the most recent run by itself and every report below is
  -- scoped to it. Set it to a script job id to analyze an older run, or to the empty
  -- string '' to deliberately report the whole window.
  DECLARE run_job_id STRING DEFAULT NULL;
  -- Report 5 only: how many characters of a statement make up its "shape". Raise it
  -- when unrelated statements are being grouped together, lower it when one statement
  -- splits into several shapes because a name is inlined into its text.
  DECLARE statement_shape_length INT64 DEFAULT 90;

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

  -- Identify the most recent 03 run, as the PARENT of the newest ANALYSIS_BATCH_PAYLOAD
  -- statement. That notice is emitted by 03 and by nothing else, and a BigQuery script
  -- stamps every statement it runs with parent_job_id = the script's own job, so the
  -- parent of that notice IS the run. Detecting the run from its own statements avoids
  -- having to recognize 03 by its script text -- which would also match this file,
  -- since it quotes the same names.
  --
  -- A run that analyzed nothing emits no such notice, so nothing is found and the
  -- reports fall back to the whole window. That is correct rather than wrong: there
  -- were no batches to attribute time to.
  IF run_job_id IS NULL THEN
    EXECUTE IMMEDIATE FORMAT(
      """
      SELECT parent_job_id
      FROM `%s.region-%s`.INFORMATION_SCHEMA.JOBS_BY_PROJECT
      WHERE creation_time > TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL @hours HOUR)
        AND query LIKE '%%ANALYSIS_BATCH_PAYLOAD%%'
        AND query NOT LIKE '%%INFORMATION_SCHEMA.JOBS%%'
        AND parent_job_id IS NOT NULL
      ORDER BY creation_time DESC
      LIMIT 1
      """,
      jobs_project_id,
      @@location
    ) INTO run_job_id USING lookback_hours AS hours;
  END IF;

  -- '' means "the whole window"; so does a failed auto-detect. Both read as NULL to
  -- the reports, whose filter is (@run IS NULL OR parent_job_id = @run).
  IF run_job_id = '' THEN
    SET run_job_id = NULL;
  END IF;

  SELECT
    'REPORT_SCOPE' AS notice,
    IFNULL(run_job_id, '(whole lookback window -- no single run identified)') AS run_job_id,
    lookback_hours AS lookback_hours;

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
    WITH payload_statements AS (
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
        AND (@run IS NULL OR parent_job_id = @run)
    )
    SELECT
      job_id,
      creation_time,
      dataset,
      batch_no,
      -- HOW LONG THAT BATCH TOOK. The notice is emitted once per batch, immediately
      -- before its UDF call, so the gap to the NEXT notice is that batch's wall time:
      -- the UDF, the staging queries and the publish -- everything the loop body does.
      -- The newest row has no successor and reads NULL, because its batch ended with
      -- the run rather than with another notice.
      TIMESTAMP_DIFF(
        LEAD(creation_time) OVER (ORDER BY creation_time),
        creation_time,
        SECOND
      ) AS batch_seconds,
      state,
      error_message,
      query_head
    FROM payload_statements
    ORDER BY creation_time DESC
    LIMIT @max_rows
    """,
    jobs_project_id,
    @@location
  );

  EXECUTE IMMEDIATE rendered_sql
  USING lookback_hours AS hours, row_limit AS max_rows, run_job_id AS run;

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
      -- Scoped like the others. A run that failed before any batch emits no payload
      -- notice, so run_job_id is NULL and this widens to the window -- which is the
      -- behaviour that finds the failure.
      AND (@run IS NULL OR parent_job_id = @run)
      AND (
        NOT @lineage_only
        OR query LIKE '%%lnge_%%'
        OR query LIKE '%%batch_udf_results%%'
        OR query LIKE '%%changed_definitions%%'
      )
    ORDER BY creation_time DESC
    LIMIT @max_rows
    """,
    jobs_project_id,
    @@location
  );

  EXECUTE IMMEDIATE rendered_sql
  USING
    lookback_hours AS hours,
    row_limit AS max_rows,
    lineage_statements_only AS lineage_only,
    run_job_id AS run;

  -- --------------------------------------------------------------------------
  -- Report 3: WHERE THE TIME WENT -- the run's statements, slowest first.
  --
  -- A BigQuery script records every statement as a child job with its own timings, so
  -- a finished run can be taken apart without adding a single marker to 03. This is
  -- the first thing to read when a run is slower than expected: the top rows name the
  -- statements to attack, and query_head says which they are.
  --
  -- elapsed_sec is wall time. slot_ms and bytes are there to tell two different kinds
  -- of slow apart: a statement with seconds of wall time and almost no slot time or
  -- bytes was waiting (job startup, queueing), and no amount of query tuning will help
  -- it -- only running fewer statements will. One with large slot time is doing real
  -- work and is worth optimizing as a query.
  -- --------------------------------------------------------------------------
  SET rendered_sql = FORMAT(
    """
    SELECT
      TIMESTAMP_DIFF(end_time, start_time, SECOND) AS elapsed_sec,
      total_slot_ms,
      total_bytes_processed,
      creation_time,
      job_id,
      SUBSTR(REGEXP_REPLACE(query, "[[:space:]]+", " "), 1, 160) AS query_head
    FROM `%s.region-%s`.INFORMATION_SCHEMA.JOBS_BY_PROJECT
    WHERE creation_time > TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL @hours HOUR)
      AND query IS NOT NULL
      AND (@run IS NULL OR parent_job_id = @run)
      AND (
        NOT @lineage_only
        OR query LIKE '%%lnge_%%'
        OR query LIKE '%%batch_%%'
        OR query LIKE '%%changed_%%'
      )
    ORDER BY elapsed_sec DESC
    LIMIT @max_rows
    """,
    jobs_project_id,
    @@location
  );

  EXECUTE IMMEDIATE rendered_sql
  USING
    lookback_hours AS hours,
    row_limit AS max_rows,
    lineage_statements_only AS lineage_only,
    run_job_id AS run;

  -- --------------------------------------------------------------------------
  -- Report 4: the same time, grouped into the phases of a 03 run.
  --
  -- Report 3 says which statements are slow; this says which PART OF THE PIPELINE
  -- they add up to, which is what decides where to spend effort. Read total_sec as a
  -- share of the run, and statements next to it: a phase with many statements and
  -- little slot time is paying job startup and gets faster by running fewer
  -- statements; a phase with few statements and high slot time needs a better query.
  --
  -- The labels are matched from the SQL text, so they are a HEURISTIC, not an
  -- instrumented measurement. They are good enough to say "STEP 2 is half the run"
  -- and not good enough to audit. A statement that matches nothing lands in
  -- 'other / unclassified'; if that bucket is large, read report 3 instead of
  -- trusting this one. The CASE is ordered -- the first match wins -- so the more
  -- specific patterns come first.
  -- --------------------------------------------------------------------------
  SET rendered_sql = FORMAT(
    """
    SELECT
      CASE
        WHEN query LIKE '%%batch_udf_results%%' THEN 'STEP3 UDF analysis'
        WHEN query LIKE '%%source_discovery_only%%'
          OR query LIKE '%%changed_definitions_with_discovery%%'
          THEN 'STEP3 discovery pre-pass'
        WHEN query LIKE '%%batch_object_metadata%%'
          OR query LIKE '%%current_target_columns%%'
          THEN 'STEP3 column metadata'
        WHEN query LIKE '%%batch_staged_%%'
          OR query LIKE '%%batch_object_status%%'
          OR query LIKE '%%batch_analysis_input%%'
          THEN 'STEP3 staging'
        WHEN query LIKE '%%ANALYSIS_BATCH_PAYLOAD%%'
          OR query LIKE '%%processing_step%%'
          THEN 'progress notices'
        WHEN query LIKE '%%lnge_t_impact%%' THEN 'STEP4 impact'
        WHEN query LIKE '%%lnge_t_object_dependency%%'
          OR query LIKE '%%lnge_t_column_usage_impact%%'
          THEN 'STEP4b static report tables'
        WHEN query LIKE '%%lnge_t_unanalyzed_definition%%'
          THEN 'STEP5 unanalyzed snapshot'
        WHEN query LIKE '%%INFORMATION_SCHEMA.JOBS%%'
          OR query LIKE '%%lnge_m_job_registry%%'
          THEN 'STEP2 job collection'
        WHEN query LIKE '%%INFORMATION_SCHEMA.VIEWS%%'
          OR query LIKE '%%INFORMATION_SCHEMA.TABLES%%'
          OR query LIKE '%%INFORMATION_SCHEMA.SCHEMATA%%'
          THEN 'STEP1 metadata discovery'
        WHEN query LIKE '%%lnge_t_direct_dependency%%'
          OR query LIKE '%%lnge_t_lineage_diagnostic%%'
          OR query LIKE '%%lnge_t_column_usage%%'
          OR query LIKE '%%lnge_m_definition_registry%%'
          THEN 'STEP3 publish'
        ELSE 'other / unclassified'
      END AS phase,
      COUNT(*) AS statements,
      SUM(TIMESTAMP_DIFF(end_time, start_time, SECOND)) AS total_sec,
      ROUND(AVG(TIMESTAMP_DIFF(end_time, start_time, SECOND)), 1) AS avg_sec,
      MAX(TIMESTAMP_DIFF(end_time, start_time, SECOND)) AS max_sec,
      SUM(total_slot_ms) AS total_slot_ms
    FROM `%s.region-%s`.INFORMATION_SCHEMA.JOBS_BY_PROJECT
    WHERE creation_time > TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL @hours HOUR)
      AND query IS NOT NULL
      AND (@run IS NULL OR parent_job_id = @run)
      AND (
        NOT @lineage_only
        OR query LIKE '%%lnge_%%'
        OR query LIKE '%%batch_%%'
        OR query LIKE '%%changed_%%'
      )
    GROUP BY phase
    ORDER BY total_sec DESC
    """,
    jobs_project_id,
    @@location
  );

  EXECUTE IMMEDIATE rendered_sql
  USING
    lookback_hours AS hours,
    lineage_statements_only AS lineage_only,
    run_job_id AS run;

  -- --------------------------------------------------------------------------
  -- Report 5: REPEATED STATEMENT SHAPES -- the same statement, run many times.
  --
  -- Reports 3 and 4 rank by time, which hides the cheapest statements. That is the
  -- wrong way round when the run's cost is the COUNT: measured on this deployment, a
  -- run's statements account for well under half its wall clock, and the rest is the
  -- gap between them -- roughly a second each, paid whether the statement does
  -- anything or not. A statement taking 0.1s a hundred times is then worth more than
  -- a 14-second query.
  --
  -- So this groups by the SHAPE of the statement -- its first characters, with
  -- whitespace collapsed -- and ranks by how often that shape ran. A shape with a
  -- high count is a loop: either a per-batch statement (expected, bounded by the
  -- batch budgets) or a per-DATASET or per-OBJECT one (not expected, and the thing to
  -- remove).
  --
  -- shape_length trims the key. Too short and unrelated statements merge; too long
  -- and the same statement with a different inlined name splits into two shapes.
  -- --------------------------------------------------------------------------
  SET rendered_sql = FORMAT(
    """
    SELECT
      COUNT(*) AS statements,
      SUM(TIMESTAMP_DIFF(end_time, start_time, SECOND)) AS total_sec,
      SUM(total_slot_ms) AS total_slot_ms,
      SUBSTR(REGEXP_REPLACE(query, "[[:space:]]+", " "), 1, @shape_len) AS statement_shape
    FROM `%s.region-%s`.INFORMATION_SCHEMA.JOBS_BY_PROJECT
    WHERE creation_time > TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL @hours HOUR)
      AND query IS NOT NULL
      AND (@run IS NULL OR parent_job_id = @run)
      AND (
        NOT @lineage_only
        OR query LIKE '%%lnge_%%'
        OR query LIKE '%%batch_%%'
        OR query LIKE '%%changed_%%'
      )
    GROUP BY statement_shape
    ORDER BY statements DESC
    LIMIT @max_rows
    """,
    jobs_project_id,
    @@location
  );

  EXECUTE IMMEDIATE rendered_sql
  USING
    lookback_hours AS hours,
    row_limit AS max_rows,
    lineage_statements_only AS lineage_only,
    run_job_id AS run,
    statement_shape_length AS shape_len;
END;
