-- ============================================================================
-- 10_pending_analysis_workload.sql
-- BigQuery Physical Lineage Repository - Pending analysis workload report
-- ============================================================================
-- Reports how much work the NEXT 03 STEP 3 run would hand to the analysis UDF,
-- broken down the way STEP 3 actually batches it.
--
-- WHY THIS EXISTS: STEP 3 avoids "UDF out of memory" by looping over datasets --
-- one UDF invocation per dataset, over that dataset's changed objects. So the
-- figure that predicts an OOM is not the total number of changed objects, it is
-- the LARGEST PER-DATASET SQL VOLUME, because that is what one UDF call has to
-- hold in the V8 heap at once. Report 1 below is exactly that unit.
--
-- WHAT TO LOOK FOR:
--   * One dataset far above the others in total_sql_bytes -- that is the
--     invocation that will OOM, and the dataset loop gives it no protection.
--   * `ephemeral_generated_sql` at the top. That is not a real dataset: it is the
--     synthetic label (03's ephemeral_object_dataset_label) that ALL temporary /
--     rotating-destination generated tables collapse into, so every one of them
--     lands in a single loop iteration no matter how many there are. This is the
--     first thing to check when Views analyze fine but generated tables OOM.
--   * A single max_sql_bytes close to total_sql_bytes -- then it is one oversized
--     object, not a crowd, and splitting the batch will not help.
--
-- The filter mirrors STEP 3's own changed-object probe (is_active, is_changed,
-- definition_text IS NOT NULL, object_type IN ('VIEW','TABLE'), plus the
-- process_generated_tables gate), so the numbers are what the next run would see.
-- Set process_generated_tables below to match the 03 setting you intend to use.
--
-- Reports 4 to 7 answer a different question: HOW MUCH OF THE WORK IS ONE-TIME.
-- Report 4 splits the repository by analysis_status, so the objects that have never
-- been analyzed (a backlog that a successful pass removes for good) are separated
-- from the ones that are simply due again. Report 5 counts genuinely NEW objects per
-- day, which is what a run costs once the backlog is gone -- a generated statement
-- that runs again tomorrow keeps its fingerprint and is seen again, not registered
-- again. Together they say whether "the pipeline is slow" or "the pipeline is still
-- catching up", and those have very different fixes.
--
-- Reports 6 and 7 settle it from the JOB side, which is the only place the answer
-- really lives: a generated statement that recurs keeps its fingerprint and costs
-- nothing after its first analysis, while one that carries a rotating id in an
-- identifier is a NEW object on every run and can never be caught up with. Report 6
-- is the histogram of how many days each fingerprint was seen; report 7 is the same
-- history day by day, with the count of fingerprints seen for the first time -- the
-- steady-state arrival rate, measured from the jobs rather than from when the
-- pipeline happened to run.
--
-- Read-only report; not part of the daily pipeline. Run it on demand -- and in
-- particular BEFORE and AFTER a run, since a successful analysis clears
-- is_changed and the pending workload shrinks.
--
-- Note on LENGTH(): it counts CHARACTERS, not bytes. For SQL text the two are
-- close enough to size a batch by (ASCII is 1:1); the column is named
-- total_sql_bytes because what it stands in for is heap footprint.
-- ============================================================================
SET @@location = 'asia-northeast1';

BEGIN
  -- --------------------------------------------------------------------------
  -- [A] REQUIRED per deployment / region -- set these
  -- --------------------------------------------------------------------------
  -- Variables are grouped by purpose below; each group is labeled with a one-line
  -- header. Full descriptions follow the block under "Variable notes".
  -- GCP project: auto-detected at runtime; its DECLARE lives in [B] (pin it there
  -- only to run against a different project).
  -- Project-token substitution
  DECLARE project_token_pattern STRING DEFAULT r'^([^-]+)';
  -- Repository dataset & table naming
  DECLARE repository_dataset STRING DEFAULT 'lineage_repository';
  DECLARE table_name_prefix STRING DEFAULT '';
  DECLARE table_name_suffix STRING DEFAULT '';
  --
  -- Variable notes (keyed by name):
  --   project_token_pattern
  --     Project-token substitution regex (keep in step with 01). A token extracted
  --     from the auto-detected project id replaces every '{project_token}'
  --     placeholder in the dataset name and the table prefix/suffix. Default: first
  --     hyphen segment.
  --   repository_dataset / table_name_prefix / table_name_suffix
  --     Lineage repository dataset (holds the definition registry) and its table
  --     naming. The physical registry table name is assembled from the
  --     prefix/suffix -- keep them in step with 01 setup.

  -- --------------------------------------------------------------------------
  -- [B] BEHAVIOR OPTIONS -- defaults are safe; tune as needed
  -- --------------------------------------------------------------------------
  -- GCP project. Declared here (not in [A]) because it is normally not set by hand:
  -- it is auto-detected in [C] from INFORMATION_SCHEMA.SCHEMATA (the project the job
  -- runs in). To pin it, set a literal in [C].
  DECLARE default_project_id STRING;
  -- Match 03's own setting. TRUE counts generated TABLEs alongside Views; FALSE
  -- reports only what a Views-only run would analyze.
  DECLARE process_generated_tables BOOL DEFAULT TRUE;
  -- Must match 03's ephemeral_object_dataset_label. Only used to flag the synthetic
  -- bucket in report 1; a stale value here makes that flag wrong, nothing else.
  DECLARE ephemeral_object_dataset_label STRING DEFAULT 'ephemeral_generated_sql';
  -- Days of arrival history in report 5. Long enough to see a weekly rhythm.
  DECLARE arrival_history_days INT64 DEFAULT 14;
  -- Days of job history in reports 6 and 7. Bounded by what 03's own JOBS lookback
  -- has actually collected -- a longer window here does not invent jobs.
  DECLARE job_history_days INT64 DEFAULT 14;

  -- --------------------------------------------------------------------------
  -- [C] DERIVED / INTERNAL -- from [A]; DO NOT edit
  -- --------------------------------------------------------------------------
  -- The repository project takes default_project_id (auto-detected below); pin it
  -- to a literal only if the repository lives in a separate project.
  DECLARE repository_project_id STRING DEFAULT NULL;
  DECLARE registry_fqn STRING;
  DECLARE job_registry_fqn STRING;
  DECLARE rendered_sql STRING;
  -- Token extracted from the project id (see project_token_pattern).
  DECLARE project_token STRING;

  -- Auto-detect the running GCP project from INFORMATION_SCHEMA.SCHEMATA
  -- (catalog_name). The region-qualified identifier is built from @@location; to
  -- pin the project, replace this SET with a literal.
  EXECUTE IMMEDIATE FORMAT(
    "SELECT DISTINCT catalog_name FROM `region-%s`.INFORMATION_SCHEMA.SCHEMATA LIMIT 1",
    @@location
  ) INTO default_project_id;
  ASSERT default_project_id IS NOT NULL AS
    'Could not auto-detect the project id from INFORMATION_SCHEMA.SCHEMATA; set default_project_id to a literal.';
  SET repository_project_id = COALESCE(repository_project_id, default_project_id);
  -- Project-token substitution in the name inputs (before names are used).
  SET project_token =
    COALESCE(REGEXP_EXTRACT(default_project_id, project_token_pattern), '');
  SET repository_dataset =
    REPLACE(repository_dataset, '{project_token}', project_token);
  SET table_name_prefix =
    REPLACE(table_name_prefix, '{project_token}', project_token);
  SET table_name_suffix =
    REPLACE(table_name_suffix, '{project_token}', project_token);

  -- Guard: an unsubstituted '{project_token}' (or any invalid character) in the
  -- dataset name is surfaced here instead of failing later at query time.
  ASSERT REGEXP_CONTAINS(repository_dataset, r'^[A-Za-z0-9_]+$')
    AS 'repository_dataset must be letters/digits/underscore only (check for an unsubstituted {project_token}).';

  ASSERT arrival_history_days >= 1 AS 'arrival_history_days must be >= 1.';
  ASSERT job_history_days >= 1 AS 'job_history_days must be >= 1.';

  SET registry_fqn = FORMAT(
    '%s.%s.%s',
    repository_project_id,
    repository_dataset,
    table_name_prefix || 'lnge_' || 'm_' || 'definition_registry' || table_name_suffix
  );
  SET job_registry_fqn = FORMAT(
    '%s.%s.%s',
    repository_project_id,
    repository_dataset,
    table_name_prefix || 'lnge_' || 'm_' || 'job_registry' || table_name_suffix
  );

  -- --------------------------------------------------------------------------
  -- Report 1: per dataset -- ONE ROW PER UDF INVOCATION.
  --
  -- This is the sizing view. STEP 3 loops over object_dataset, so each row here is
  -- one UDF call's worth of SQL. Read total_sql_bytes top-down.
  -- --------------------------------------------------------------------------
  SET rendered_sql = FORMAT(
    """
    SELECT
      object_dataset,
      COUNT(*) AS changed_objects,
      SUM(LENGTH(definition_text)) AS total_sql_bytes,
      MAX(LENGTH(definition_text)) AS max_sql_bytes,
      CAST(ROUND(AVG(LENGTH(definition_text))) AS INT64) AS avg_sql_bytes,
      -- TRUE marks the synthetic bucket every ephemeral generated table collapses
      -- into: many objects, one loop iteration, no protection from the dataset loop.
      (LOWER(object_dataset) = LOWER(@ephemeral_label)) AS is_ephemeral_bucket,
      COUNT(DISTINCT generation_type) AS generation_type_count
    FROM `%s`
    WHERE is_active = TRUE
      AND is_changed = TRUE
      AND definition_text IS NOT NULL
      AND object_type IN ('VIEW', 'TABLE')
      AND (@include_tables OR object_type = 'VIEW')
    GROUP BY object_dataset
    ORDER BY total_sql_bytes DESC
    """,
    registry_fqn
  );

  EXECUTE IMMEDIATE rendered_sql
  USING
    process_generated_tables AS include_tables,
    ephemeral_object_dataset_label AS ephemeral_label;

  -- --------------------------------------------------------------------------
  -- Report 2: the same workload split by object kind, to say WHAT is in a heavy
  -- dataset (Views, DAG-generated tables, Scheduled Query outputs).
  -- --------------------------------------------------------------------------
  SET rendered_sql = FORMAT(
    """
    SELECT
      object_dataset,
      object_type,
      generation_type,
      COUNT(*) AS changed_objects,
      SUM(LENGTH(definition_text)) AS total_sql_bytes,
      MAX(LENGTH(definition_text)) AS max_sql_bytes
    FROM `%s`
    WHERE is_active = TRUE
      AND is_changed = TRUE
      AND definition_text IS NOT NULL
      AND object_type IN ('VIEW', 'TABLE')
      AND (@include_tables OR object_type = 'VIEW')
    GROUP BY object_dataset, object_type, generation_type
    ORDER BY total_sql_bytes DESC
    """,
    registry_fqn
  );

  EXECUTE IMMEDIATE rendered_sql
  USING process_generated_tables AS include_tables;

  -- --------------------------------------------------------------------------
  -- Report 3: run total, so the two reports above can be read as shares.
  -- --------------------------------------------------------------------------
  SET rendered_sql = FORMAT(
    """
    SELECT
      COUNT(DISTINCT object_dataset) AS datasets_to_loop,
      COUNT(*) AS changed_objects,
      SUM(LENGTH(definition_text)) AS total_sql_bytes,
      MAX(LENGTH(definition_text)) AS largest_single_object_bytes
    FROM `%s`
    WHERE is_active = TRUE
      AND is_changed = TRUE
      AND definition_text IS NOT NULL
      AND object_type IN ('VIEW', 'TABLE')
      AND (@include_tables OR object_type = 'VIEW')
    """,
    registry_fqn
  );

  EXECUTE IMMEDIATE rendered_sql
  USING process_generated_tables AS include_tables;

  -- --------------------------------------------------------------------------
  -- Report 4: the BACKLOG -- how much of the repository has never been analyzed.
  --
  -- Reports 1-3 size the NEXT run. This one says how much of that is a one-time
  -- debt rather than the daily rhythm, which is the difference between "the pipeline
  -- is slow" and "the pipeline is still catching up". is_changed is sticky and is
  -- cleared only by a successful analysis, so an object that has never been analyzed
  -- (or whose analysis failed) stays in the pending workload run after run until it
  -- succeeds once.
  --
  -- analysis_status reads:
  --   COMPLETED                   analyzed; will not be re-analyzed unless its SQL
  --                               changes
  --   FAILED_UDF_RESOURCE_ERROR   a batch the UDF could not fit in memory; STEP 3
  --                               recorded it and carried on. Retry with smaller
  --                               batch budgets after setting is_changed = TRUE.
  --   NULL                        never analyzed at all
  -- Read still_pending against the totals: if most of the pending work is objects
  -- that have NEVER completed, one successful full pass removes it permanently.
  -- --------------------------------------------------------------------------
  SET rendered_sql = FORMAT(
    """
    SELECT
      (LOWER(object_dataset) = LOWER(@ephemeral_label)) AS is_ephemeral_bucket,
      COALESCE(analysis_status, 'NEVER_ANALYZED') AS analysis_status,
      COUNT(*) AS objects,
      SUM(LENGTH(definition_text)) AS total_sql_bytes,
      COUNTIF(is_changed) AS still_pending,
      SUM(IF(is_changed, LENGTH(definition_text), 0)) AS pending_sql_bytes
    FROM `%s`
    WHERE is_active = TRUE
      AND definition_text IS NOT NULL
      AND object_type IN ('VIEW', 'TABLE')
    GROUP BY is_ephemeral_bucket, analysis_status
    ORDER BY is_ephemeral_bucket DESC, total_sql_bytes DESC
    """,
    registry_fqn
  );

  EXECUTE IMMEDIATE rendered_sql
  USING ephemeral_object_dataset_label AS ephemeral_label;

  -- --------------------------------------------------------------------------
  -- Report 5: the ARRIVAL RATE -- how many objects are genuinely NEW per day.
  --
  -- This is what a steady-state run costs once the backlog is gone. A generated
  -- statement that runs again tomorrow with the same structure keeps its
  -- fingerprint, so it is seen again rather than registered again: it does not come
  -- back into the workload. Only a NEW statement does, and that is what this counts.
  --
  -- CAVEAT on the first rows: first_seen_at is when THIS PIPELINE first saw the
  -- object, not when it was created. The day of the initial load, and the first day
  -- after widening the dataset filters or the lookback, both show the whole history
  -- arriving at once. Read the recent, ordinary days -- and ignore a day on which no
  -- run completed, which shows as a gap rather than a zero.
  -- --------------------------------------------------------------------------
  SET rendered_sql = FORMAT(
    """
    SELECT
      DATE(first_seen_at) AS first_seen_date,
      COUNTIF(LOWER(object_dataset) = LOWER(@ephemeral_label)) AS new_ephemeral_objects,
      SUM(IF(
        LOWER(object_dataset) = LOWER(@ephemeral_label),
        LENGTH(definition_text),
        0
      )) AS new_ephemeral_sql_bytes,
      COUNTIF(LOWER(object_dataset) != LOWER(@ephemeral_label)) AS new_other_objects,
      COUNT(*) AS new_objects_total
    FROM `%s`
    WHERE is_active = TRUE
      AND definition_text IS NOT NULL
      AND object_type IN ('VIEW', 'TABLE')
      AND first_seen_at >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL @days DAY)
    GROUP BY first_seen_date
    ORDER BY first_seen_date DESC
    """,
    registry_fqn
  );

  EXECUTE IMMEDIATE rendered_sql
  USING
    ephemeral_object_dataset_label AS ephemeral_label,
    arrival_history_days AS days;

  -- --------------------------------------------------------------------------
  -- Report 6: DO THE GENERATED STATEMENTS RECUR? -- fingerprint lifetime histogram.
  --
  -- This is the question report 5 cannot answer from two rows. An ephemeral object
  -- is identified by its fingerprint, so a statement that runs again tomorrow with
  -- the same structure is SEEN again (no new object, no analysis). One that carries a
  -- rotating id inside an identifier gets a new fingerprint every run, and arrives as
  -- a brand new object every day forever.
  --
  -- active_days is how many distinct days a fingerprint was seen in the job history:
  --   active_days = 1 for most fingerprints -> they CHURN. Today's 3,880 objects are
  --                 tomorrow's 3,880 different objects, the backlog never clears, and
  --                 no amount of catching up makes a run cheaper.
  --   active_days spread across the window -> they RECUR. The population is stable,
  --                 today's load is a one-time backfill, and a steady-state run only
  --                 pays for genuinely new statements.
  --
  -- CAVEAT: this reads the job registry, which holds what 03 has COLLECTED. A day on
  -- which no run completed contributes no jobs, and will deflate active_days for
  -- every fingerprint. Check report 7's jobs_collected column before concluding
  -- "churn" -- a one-row-per-day pattern there means the history is too thin to tell.
  -- --------------------------------------------------------------------------
  SET rendered_sql = FORMAT(
    """
    WITH job_days AS (
      SELECT DISTINCT sql_fingerprint, DATE(creation_time) AS job_date
      FROM `%s`
      WHERE sql_fingerprint IS NOT NULL
        AND creation_time >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL @days DAY)
    ),
    per_fingerprint AS (
      SELECT sql_fingerprint, COUNT(*) AS active_days
      FROM job_days
      GROUP BY sql_fingerprint
    )
    SELECT
      active_days,
      COUNT(*) AS fingerprints,
      ROUND(100 * COUNT(*) / SUM(COUNT(*)) OVER (), 1) AS pct_of_fingerprints
    FROM per_fingerprint
    GROUP BY active_days
    ORDER BY active_days
    """,
    job_registry_fqn
  );

  EXECUTE IMMEDIATE rendered_sql
  USING job_history_days AS days;

  -- --------------------------------------------------------------------------
  -- Report 7: the same history day by day -- how many fingerprints ran, and how many
  -- of them had never been seen before that day.
  --
  -- new_fingerprints is the steady-state arrival rate, measured from the jobs
  -- themselves rather than from when the pipeline happened to run. The first day of
  -- the window counts everything as new by construction (nothing precedes it), so
  -- read the LATER rows.
  --
  -- jobs_collected near zero on a day means 03 did not collect that day, not that
  -- nothing ran -- see the caveat on report 6.
  -- --------------------------------------------------------------------------
  SET rendered_sql = FORMAT(
    """
    WITH jobs AS (
      SELECT sql_fingerprint, DATE(creation_time) AS job_date
      FROM `%s`
      WHERE sql_fingerprint IS NOT NULL
        AND creation_time >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL @days DAY)
    ),
    first_day AS (
      SELECT sql_fingerprint, MIN(job_date) AS first_job_date
      FROM jobs
      GROUP BY sql_fingerprint
    )
    SELECT
      jobs.job_date,
      COUNT(*) AS jobs_collected,
      COUNT(DISTINCT jobs.sql_fingerprint) AS distinct_fingerprints,
      COUNT(DISTINCT IF(
        first_day.first_job_date = jobs.job_date,
        jobs.sql_fingerprint,
        NULL
      )) AS new_fingerprints
    FROM jobs
    INNER JOIN first_day
      ON first_day.sql_fingerprint = jobs.sql_fingerprint
    GROUP BY jobs.job_date
    ORDER BY jobs.job_date DESC
    """,
    job_registry_fqn
  );

  EXECUTE IMMEDIATE rendered_sql
  USING job_history_days AS days;
END;
