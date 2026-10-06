-- ============================================================================
-- 13_sql_pattern_drift.sql
-- BigQuery Physical Lineage Repository - Why the same model keeps arriving as new SQL
-- ============================================================================
-- Answers one operational question: a scheduler (dbt, a DAG) runs the SAME model every
-- day, so after the first run it should produce no new work -- why does the pipeline
-- keep registering new ephemeral objects?
--
-- An ephemeral object's identity is its sql_fingerprint. If a model's SQL is
-- byte-identical every day, it keeps one fingerprint and is analyzed once. A new
-- fingerprint every day means something in the generated SQL CHANGES every day, and
-- the fingerprint does not normalize it.
--
-- THE HANDLE THIS REPORT USES IS SOMETHING THAT STAYS THE SAME WHILE THE SQL MOVES.
-- By default that is the destination table, which is stable even when the SQL is not
-- -- dbt writes `<model>__dbt_tmp`, a DAG writes a fixed staging table -- so:
--
--     same destination + many fingerprints = that model's SQL is drifting
--
-- and the destination names WHICH model, which is what makes the finding actionable
-- against the project that generates it.
--
-- WHEN THE DESTINATION DOES NOT WORK: a statement with no destination of its own
-- lands in a per-job anonymous table, so every job becomes its own group and report 1
-- comes back empty or all ones. Then group by a job LABEL instead
-- (group_by_label_key): report 0 lists the label keys and how many distinct values
-- each has, and a key with few values that recur daily is a model identifier. An
-- invocation id has as many values as jobs and identifies the run, not the model.
--
-- START WITH REPORT 4. It asks the question directly -- of the objects that arrived
-- today, how many are a statement the repository has not seen, and how many are an
-- old statement with different numbers in it -- and answers it with two counts.
-- Report 5 then shows those differences, one row per object, with the text around the
-- first character that differs. Reports 0 to 3 are the same investigation from the
-- job side, for when the question is "which model is doing this".
--
-- Report 1 ranks destinations by how many fingerprints they produced. Report 2 opens
-- one destination up, fingerprint by fingerprint, with first and last seen. Report 3
-- is the one that ends the discussion: it takes that destination's two most recent
-- fingerprints and prints the text AROUND THE FIRST CHARACTER THAT DIFFERS, so what
-- varies is visible without reading kilobytes of SQL.
--
-- Read-only; touches no repository table other than reading the job registry.
--
-- SCOPE NOTE: this reads the JOB REGISTRY, which holds what 03 collected, so it sees
-- as far back as the lookback windows have reached -- not the whole history of JOBS.
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
  --     Lineage repository dataset and its table naming. The job registry name is
  --     assembled from the prefix/suffix -- keep them in step with 01 setup.

  -- --------------------------------------------------------------------------
  -- [B] BEHAVIOR OPTIONS -- defaults are safe; tune as needed
  -- --------------------------------------------------------------------------
  -- GCP project. Declared here (not in [A]) because it is normally not set by hand:
  -- it is auto-detected in [C] from INFORMATION_SCHEMA.SCHEMATA (the project the job
  -- runs in). To pin it, set a literal in [C].
  DECLARE default_project_id STRING;
  -- How much job history to read. Bounded by what 03 has collected.
  DECLARE lookback_days INT64 DEFAULT 14;
  -- Rows in report 1.
  DECLARE row_limit INT64 DEFAULT 20;
  -- HOW TO GROUP THE JOBS. NULL groups by destination table, which works when the
  -- destination is stable (dbt's `<model>__dbt_tmp`, a DAG's staging table).
  --
  -- It does NOT work when the destination rotates -- a SELECT with no destination
  -- lands in a per-job anonymous table, and then every job is its own group and
  -- report 1 comes back empty or all ones. Set this to a job LABEL KEY instead, and
  -- jobs are grouped by that label's value. Report 0 lists the keys available and how
  -- many distinct values each has: a key with a handful of values that recur every day
  -- is a model identifier, which is the handle wanted here.
  DECLARE group_by_label_key STRING DEFAULT NULL;
  -- Which destination report 2 and 3 open up. NULL takes the worst offender from
  -- report 1 -- the destination with the most fingerprints. Set it to a table name to
  -- investigate a specific model.
  DECLARE inspect_destination_table STRING DEFAULT NULL;
  -- Report 3: how many characters to print around the first difference, and how many
  -- of them sit BEFORE it. The lead-in is what makes the difference readable -- the
  -- same clause is shown from both versions, so the eye lands on the one token that
  -- changed.
  DECLARE difference_window INT64 DEFAULT 160;
  DECLARE difference_lead_in INT64 DEFAULT 40;
  -- Reports 4 and 5: how many days back counts as "newly arrived". 1 is today only.
  DECLARE new_object_days INT64 DEFAULT 1;
  -- Report 5: how many of the new objects to print with their twin.
  DECLARE new_object_examples INT64 DEFAULT 5;
  -- Report 3 compares character by character, which is linear in the text length, so
  -- the search is capped. Raise it only if two versions are identical for longer than
  -- this and the report says so.
  DECLARE difference_max_scan INT64 DEFAULT 20000;

  -- --------------------------------------------------------------------------
  -- [C] DERIVED / INTERNAL -- from [A]/[B]; DO NOT edit
  -- --------------------------------------------------------------------------
  -- The repository project takes default_project_id (auto-detected below); pin it to
  -- a literal only if the repository lives in a separate project.
  DECLARE repository_project_id STRING DEFAULT NULL;
  DECLARE job_registry_fqn STRING;
  DECLARE registry_fqn STRING;
  -- The SQL expression that groups jobs: a destination table, or a label's value.
  DECLARE group_expression STRING;
  DECLARE rendered_sql STRING;
  -- Token extracted from the project id (see project_token_pattern).
  DECLARE project_token STRING;

  -- Auto-detect the running GCP project from INFORMATION_SCHEMA.SCHEMATA
  -- (catalog_name). The region-qualified identifier is built from @@location.
  EXECUTE IMMEDIATE FORMAT(
    "SELECT DISTINCT catalog_name FROM `region-%s`.INFORMATION_SCHEMA.SCHEMATA LIMIT 1",
    @@location
  ) INTO default_project_id;
  ASSERT default_project_id IS NOT NULL AS
    'Could not auto-detect the project id from INFORMATION_SCHEMA.SCHEMATA; set default_project_id to a literal.';
  SET repository_project_id = COALESCE(repository_project_id, default_project_id);
  SET project_token =
    COALESCE(REGEXP_EXTRACT(default_project_id, project_token_pattern), '');
  SET repository_dataset =
    REPLACE(repository_dataset, '{project_token}', project_token);
  SET table_name_prefix =
    REPLACE(table_name_prefix, '{project_token}', project_token);
  SET table_name_suffix =
    REPLACE(table_name_suffix, '{project_token}', project_token);

  ASSERT REGEXP_CONTAINS(repository_dataset, r'^[A-Za-z0-9_]+$')
    AS 'repository_dataset must be letters/digits/underscore only (check for an unsubstituted {project_token}).';
  ASSERT lookback_days >= 1 AS 'lookback_days must be >= 1.';
  ASSERT row_limit >= 1 AS 'row_limit must be >= 1.';
  ASSERT difference_window >= 20 AS 'difference_window must be >= 20.';
  ASSERT difference_lead_in >= 0 AS 'difference_lead_in must be >= 0.';
  ASSERT difference_max_scan >= 100 AS 'difference_max_scan must be >= 100.';
  ASSERT new_object_days >= 1 AS 'new_object_days must be >= 1.';
  ASSERT new_object_examples >= 1 AS 'new_object_examples must be >= 1.';

  -- What identifies "the same job, run again". Built once and inlined into the three
  -- reports, so they all group the same way.
  SET group_expression = IF(
    group_by_label_key IS NULL,
    'destination_table',
    FORMAT(
      '(SELECT label.value FROM UNNEST(labels) AS label WHERE label.key = %T)',
      group_by_label_key
    )
  );

  SET job_registry_fqn = FORMAT(
    '%s.%s.%s',
    repository_project_id,
    repository_dataset,
    table_name_prefix || 'lnge_' || 'm_' || 'job_registry' || table_name_suffix
  );
  SET registry_fqn = FORMAT(
    '%s.%s.%s',
    repository_project_id,
    repository_dataset,
    table_name_prefix || 'lnge_' || 'm_' || 'definition_registry' || table_name_suffix
  );

  -- --------------------------------------------------------------------------
  -- Report 0: the job LABELS available, and how well each identifies a model.
  --
  -- Only useful when the destination does not work as a handle. A label key whose
  -- distinct_values is small and stable across days names something that recurs -- a
  -- model, a DAG task -- and is what to put in group_by_label_key. A key with as many
  -- values as there are jobs (an invocation id) identifies the RUN, not the model, and
  -- is useless for grouping.
  -- --------------------------------------------------------------------------
  SET rendered_sql = FORMAT(
    """
    SELECT
      label.key AS label_key,
      COUNT(DISTINCT label.value) AS distinct_values,
      COUNT(DISTINCT DATE(creation_time)) AS days,
      COUNT(*) AS jobs
    FROM `%s`, UNNEST(labels) AS label
    WHERE creation_time >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL @days DAY)
    GROUP BY label_key
    ORDER BY jobs DESC
    LIMIT @max_rows
    """,
    job_registry_fqn
  );

  EXECUTE IMMEDIATE rendered_sql
  USING lookback_days AS days, row_limit AS max_rows;

  -- --------------------------------------------------------------------------
  -- Report 1: job groups whose SQL is not stable.
  --
  -- fingerprints is the count of distinct sql_fingerprint values that wrote to this
  -- destination. days is how many distinct days it ran. The two together say which
  -- kind of drift it is:
  --   fingerprints = 1                 stable. Analyzed once, costs nothing after.
  --   fingerprints close to days       a NEW fingerprint every run. This is what
  --                                    makes a daily run expensive, and report 3 says
  --                                    what changes.
  --   fingerprints small but > 1       the model was edited that many times. Normal.
  -- --------------------------------------------------------------------------
  SET rendered_sql = FORMAT(
    """
    SELECT
      %s AS job_group,
      COUNT(DISTINCT sql_fingerprint) AS fingerprints,
      COUNT(DISTINCT DATE(creation_time)) AS days,
      COUNT(*) AS jobs
    FROM `%s`
    WHERE sql_fingerprint IS NOT NULL
      AND creation_time >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL @days DAY)
    GROUP BY job_group
    HAVING fingerprints > 1
    ORDER BY fingerprints DESC, jobs DESC
    LIMIT @max_rows
    """,
    group_expression,
    job_registry_fqn
  );

  EXECUTE IMMEDIATE rendered_sql
  USING lookback_days AS days, row_limit AS max_rows;

  -- Pick the destination to open up: the one with the most fingerprints.
  IF inspect_destination_table IS NULL THEN
    EXECUTE IMMEDIATE FORMAT(
      """
      SELECT %s AS job_group
      FROM `%s`
      WHERE sql_fingerprint IS NOT NULL
        AND creation_time >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL @days DAY)
      GROUP BY job_group
      ORDER BY COUNT(DISTINCT sql_fingerprint) DESC, COUNT(*) DESC
      LIMIT 1
      """,
      group_expression,
      job_registry_fqn
    ) INTO inspect_destination_table USING lookback_days AS days;
  END IF;

  SELECT
    'INSPECTING' AS notice,
    inspect_destination_table AS job_group,
    IFNULL(group_by_label_key, 'destination_table') AS grouped_by,
    lookback_days AS lookback_days;

  -- --------------------------------------------------------------------------
  -- Report 2: that destination's fingerprints, newest first.
  --
  -- One row per distinct version of the SQL, with when it was first and last seen and
  -- how long the text is. A column of single-job rows, each seen on one day, is a
  -- model whose SQL is rewritten every run.
  -- --------------------------------------------------------------------------
  SET rendered_sql = FORMAT(
    """
    SELECT
      SUBSTR(sql_fingerprint, 1, 12) AS fingerprint,
      COUNT(*) AS jobs,
      MIN(DATE(creation_time)) AS first_day,
      MAX(DATE(creation_time)) AS last_day,
      MAX(LENGTH(definition_text)) AS sql_length
    FROM `%s`
    WHERE %s = @target
      AND sql_fingerprint IS NOT NULL
      AND creation_time >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL @days DAY)
    GROUP BY sql_fingerprint
    ORDER BY last_day DESC, jobs DESC
    LIMIT @max_rows
    """,
    job_registry_fqn,
    group_expression
  );

  EXECUTE IMMEDIATE rendered_sql
  USING
    inspect_destination_table AS target,
    lookback_days AS days,
    row_limit AS max_rows;

  -- --------------------------------------------------------------------------
  -- Report 3: WHAT ACTUALLY DIFFERS, between the two most recent versions.
  --
  -- Takes that destination's two newest fingerprints and finds the first character
  -- where their SQL diverges, then prints a window from each around that point. The
  -- two strings line up, so the differing token is the one thing that is not the same
  -- on both lines -- a date, a run id, an ORDER BY, a reordered column list.
  --
  -- common_prefix is where they stop matching. Compared with sql_length it also says
  -- WHERE the change is: near the start is a header or a configuration line, near the
  -- end is often a trailing filter or a partition clause.
  --
  -- If common_prefix equals difference_max_scan, the two are identical for longer than
  -- the search went: raise difference_max_scan.
  -- --------------------------------------------------------------------------
  SET rendered_sql = FORMAT(
    """
    WITH versions AS (
      SELECT
        sql_fingerprint,
        ANY_VALUE(definition_text) AS sql_text,
        MAX(creation_time) AS last_seen
      FROM `%s`
      WHERE %s = @target
        AND sql_fingerprint IS NOT NULL
        AND definition_text IS NOT NULL
        AND creation_time >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL @days DAY)
      GROUP BY sql_fingerprint
      ORDER BY last_seen DESC
      LIMIT 2
    ),
    pair AS (
      SELECT
        ARRAY_AGG(sql_text ORDER BY last_seen DESC)[SAFE_OFFSET(0)] AS newer_sql,
        ARRAY_AGG(sql_text ORDER BY last_seen DESC)[SAFE_OFFSET(1)] AS older_sql
      FROM versions
    ),
    divergence AS (
      SELECT
        newer_sql,
        older_sql,
        -- The longest prefix the two share. Linear in the text, capped by
        -- difference_max_scan so a pair of very long statements cannot run away.
        (
          SELECT MAX(n)
          FROM UNNEST(GENERATE_ARRAY(
            0,
            LEAST(LENGTH(newer_sql), LENGTH(older_sql), @max_scan)
          )) AS n
          WHERE SUBSTR(newer_sql, 1, n) = SUBSTR(older_sql, 1, n)
        ) AS common_prefix
      FROM pair
      WHERE older_sql IS NOT NULL
    )
    SELECT
      common_prefix,
      LENGTH(newer_sql) AS newer_length,
      LENGTH(older_sql) AS older_length,
      SUBSTR(newer_sql, GREATEST(1, common_prefix - @lead_in), @text_window) AS newer_text,
      SUBSTR(older_sql, GREATEST(1, common_prefix - @lead_in), @text_window) AS older_text
    FROM divergence
    """,
    job_registry_fqn,
    group_expression
  );

  EXECUTE IMMEDIATE rendered_sql
  USING
    inspect_destination_table AS target,
    lookback_days AS days,
    difference_max_scan AS max_scan,
    difference_lead_in AS lead_in,
    difference_window AS text_window;

  -- --------------------------------------------------------------------------
  -- Report 4: OF THE OBJECTS THAT ARRIVED TODAY, HOW MANY ARE REALLY NEW?
  --
  -- This is the question behind all the others, asked directly. For every ephemeral
  -- object first seen in the last new_object_days, it looks for ANOTHER object whose
  -- SQL is identical once every digit is folded away. If one exists, the new object is
  -- not a new statement -- it is the same statement with different numbers in it, and
  -- the fingerprint could in principle have collapsed them.
  --
  -- The twin is any other object, NOT an older one. first_seen_at is set by the MERGE
  -- that registered the row, so every object a rebuilt repository holds carries the
  -- same value and "older" would match nothing -- the report would answer 0 by
  -- construction, which is the opposite of the truth.
  --
  --   with_twin     arrived today, and an older object differs only in digits.
  --                 This is the remaining opportunity, and report 5 shows what the
  --                 digits are so it can be judged.
  --   without_twin  arrived today and matches nothing older even with all digits
  --                 folded. A genuinely new statement -- a new model, or an edited
  --                 one. Nothing to fold; this is work the pipeline SHOULD do.
  --
  -- If without_twin accounts for nearly all of them, the daily arrivals are real and
  -- the fingerprint is doing its job. If with_twin dominates, read report 5.
  --
  -- The key folds EVERY digit, including the short ones the deployed rule deliberately
  -- keeps. That is on purpose: this report measures the opportunity, it does not
  -- propose taking it -- short digit runs were measured to recur daily, which is what
  -- a name does, not a parameter.
  -- --------------------------------------------------------------------------
  SET rendered_sql = FORMAT(
    """
    WITH ephemeral AS (
      SELECT
        object_name,
        definition_text,
        first_seen_at,
        REGEXP_REPLACE(
          UPPER(
            REGEXP_REPLACE(
              REGEXP_REPLACE(
                REPLACE(definition_text, '`', ''),
                "'[^']*'", "'?'"
              ),
              '[[:space:]]+', ' '
            )
          ),
          '[0-9]+', '#'
        ) AS digit_free_key
      FROM `%s`
      WHERE is_active = TRUE
        AND is_ephemeral = TRUE
        AND definition_text IS NOT NULL
    ),
    arrivals AS (
      SELECT *
      FROM ephemeral
      WHERE first_seen_at >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL @days DAY)
    )
    SELECT
      (SELECT COUNT(*) FROM arrivals) AS arrived,
      (
        SELECT COUNT(*)
        FROM arrivals AS a
        WHERE EXISTS (
          SELECT 1
          FROM ephemeral AS twin
          WHERE twin.digit_free_key = a.digit_free_key
            AND twin.object_name != a.object_name
        )
      ) AS with_twin,
      (
        SELECT COUNT(*)
        FROM arrivals AS a
        WHERE NOT EXISTS (
          SELECT 1
          FROM ephemeral AS twin
          WHERE twin.digit_free_key = a.digit_free_key
            AND twin.object_name != a.object_name
        )
      ) AS without_twin,
      -- The guard. first_seen_at is set by the MERGE that registered the row, so a
      -- repository rebuilt from 01 gives EVERY object the same value. When that is the
      -- case, "arrived in the last N days" is the whole population and arrived says
      -- nothing about a daily rate -- which these two columns make visible instead of
      -- leaving it to be inferred.
      (SELECT COUNT(DISTINCT DATE(first_seen_at)) FROM ephemeral) AS first_seen_days,
      (SELECT MIN(DATE(first_seen_at)) FROM ephemeral) AS oldest_first_seen
    """,
    registry_fqn
  );

  EXECUTE IMMEDIATE rendered_sql
  USING new_object_days AS days;

  -- --------------------------------------------------------------------------
  -- Report 5: the twins, with the difference shown.
  --
  -- One row per newly arrived object that has an older twin: the two names, where
  -- their SQL first diverges, and a window from each around that point. The windows
  -- start at the same offset and are the same length, so the differing token is the
  -- one thing that is not the same on both lines.
  --
  -- What to look for, and what each answer means:
  --   a date, a timestamp, a long id   should already fold -- if it does not, the
  --                                    fingerprint has a gap and it is fixable here
  --   a 1 or 2-digit number            folding it would also merge `_v1` with `_v2`;
  --                                    measured to recur daily, so deliberately kept
  --   a product code or similar        a real parameter. Whether to fold it is a
  --                                    judgement about whether the lineage differs
  --   nothing visible in the window    the difference is further in: raise
  --                                    difference_lead_in or difference_window
  -- --------------------------------------------------------------------------
  SET rendered_sql = FORMAT(
    """
    WITH ephemeral AS (
      SELECT
        object_name,
        definition_text,
        first_seen_at,
        REGEXP_REPLACE(
          UPPER(
            REGEXP_REPLACE(
              REGEXP_REPLACE(
                REPLACE(definition_text, '`', ''),
                "'[^']*'", "'?'"
              ),
              '[[:space:]]+', ' '
            )
          ),
          '[0-9]+', '#'
        ) AS digit_free_key
      FROM `%s`
      WHERE is_active = TRUE
        AND is_ephemeral = TRUE
        AND definition_text IS NOT NULL
    ),
    paired AS (
      SELECT
        a.object_name AS new_object,
        older.object_name AS twin_object,
        a.definition_text AS new_sql,
        older.definition_text AS twin_sql
      FROM ephemeral AS a
      INNER JOIN ephemeral AS older
        ON  older.digit_free_key = a.digit_free_key
        AND older.object_name != a.object_name
      WHERE a.first_seen_at >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL @days DAY)
      QUALIFY ROW_NUMBER() OVER (PARTITION BY a.object_name ORDER BY older.object_name)
        = 1
    ),
    divergence AS (
      SELECT
        new_object,
        twin_object,
        new_sql,
        twin_sql,
        (
          SELECT MAX(n)
          FROM UNNEST(GENERATE_ARRAY(
            0,
            LEAST(LENGTH(new_sql), LENGTH(twin_sql), @max_scan)
          )) AS n
          WHERE SUBSTR(new_sql, 1, n) = SUBSTR(twin_sql, 1, n)
        ) AS common_prefix
      FROM paired
    )
    SELECT
      SUBSTR(new_object, 1, 16) AS new_object,
      SUBSTR(twin_object, 1, 16) AS twin_object,
      common_prefix,
      SUBSTR(new_sql, GREATEST(1, common_prefix - @lead_in), @text_window) AS new_text,
      SUBSTR(twin_sql, GREATEST(1, common_prefix - @lead_in), @text_window) AS twin_text
    FROM divergence
    ORDER BY common_prefix
    LIMIT @max_rows
    """,
    registry_fqn
  );

  EXECUTE IMMEDIATE rendered_sql
  USING
    new_object_days AS days,
    difference_max_scan AS max_scan,
    difference_lead_in AS lead_in,
    difference_window AS text_window,
    new_object_examples AS max_rows;
END;
