-- ============================================================================
-- 12_ephemeral_sql_similarity.sql
-- BigQuery Physical Lineage Repository - Ephemeral SQL near-duplicate report
-- ============================================================================
-- Asks one question: how many of the EPHEMERAL objects would collapse into one
-- another if the fingerprint also normalized DIGITS INSIDE IDENTIFIERS -- and would
-- collapsing them lose lineage?
--
-- WHY THIS QUESTION: ephemeral objects (temporary / rotating-destination generated
-- tables) are already deduplicated by sql_fingerprint, which normalizes string and
-- number LITERALS, comments, whitespace, case and backticks. So two runs of "the
-- same SQL with different parameters" should already be one object. When hundreds
-- survive anyway, the parameter is not reaching the SQL as a literal -- the usual
-- cause is a digit-bearing identifier (a temp table whose name carries a per-run id,
-- or a date-suffixed table), which the tokenizer sees as one IDENTIFIER token and the
-- fingerprint keeps intact.
--
-- HOW THE MEASUREMENT WORKS: every object in the registry is already distinct under
-- the current fingerprint, so COUNT(*) is the baseline for free. Grouping those rows
-- by a key that additionally folds digit runs shows exactly the EXTRA collapse that
-- normalizing identifier digits would buy. Nothing else needs normalizing here:
-- anything the fingerprint already handles cannot be the reason two rows survived.
--
-- THE CATCH, WHICH IS WHY REPORT 2 EXISTS: collapsing is not free. Each ephemeral
-- object keeps one representative definition, and its lineage is the lineage of that
-- representative. If the members of a group read DIFFERENT source tables, merging
-- them keeps one set of edges and discards the rest. Report 2 therefore counts the
-- distinct source-table sets per group, from lnge_t_direct_dependency:
--   distinct_source_sets = 1  -> merging is LOSSLESS; the members' lineage is identical
--   distinct_source_sets > 1  -> merging would DROP edges; look before deciding
--   distinct_source_sets = 0  -> no member has been analyzed yet, so there is no
--                                evidence either way (counted separately, as unknown)
--
-- Report 3 then opens the biggest groups up member by member, so what actually
-- differs between them is visible by eye rather than inferred, and report 4 censuses
-- the digit runs inside identifiers so the kind of digit -- date, code, id -- is
-- counted rather than assumed.
--
-- WHICH DIGITS, NOT HOW MANY, IS THE REAL DECISION. A length threshold cannot tell
-- `202601` (a month) from `123456` (a product code), and the measured collapse lives
-- almost entirely in 6-7 digit runs -- exactly the length a code is likely to be. So
-- report 4 counts the digit runs by length and by whether they parse as a date,
-- which is what says whether folding at a given length is a merge or a MIS-merge.
-- Report 1's thresholds quantify the prize; report 4 says whether it is ours to take.
--
-- HOW MUCH TO FOLD, GIVEN THAT: folding from one digit up also merges things
-- that are genuinely different -- `table_v1` and `table_v2` are two tables, while
-- `events_20260101` and `events_20260102` are two days of one. Report 1 therefore
-- reports one row per threshold in digit_run_thresholds (a floor on the length of a
-- digit run before it is folded), so the cost of the cautious rule is measured rather
-- than assumed: if the 6-digit row collapses nearly as much as the 1-digit row, there
-- is no reason to take the 1-digit risk. Reports 2 and 3 use detail_min_digit_run.
--
-- Read-only report; changes nothing. Run it to decide whether extending
-- fingerprintSqlForBigQuery is worth the one-off re-registration it would cause
-- (the ephemeral definition_hash IS the fingerprint, so changing it re-identifies
-- every ephemeral object once).
--
-- NOTE ON THE NORMALIZATION: the key re-does on raw text what the fingerprint does on
-- tokens (strip backticks, collapse quoted literals to '?', collapse whitespace,
-- uppercase) and then folds digit runs of at least min_digit_run digits to '#'. The
-- fingerprint's own normalizations
-- are repeated on purpose: without them, two definitions that differ in BOTH a digit
-- and a space would not group here even though a digit-aware fingerprint would collapse
-- them, so the measurement would understate the gain. Digits are folded wholesale, so
-- standalone numbers fold too -- harmless, since two objects differing only in a
-- numeric literal already share a fingerprint and cannot both be in the registry.
--
-- The key is deliberately a LITTLE coarser than a real digit-aware fingerprint (it
-- cannot tell an identifier from a keyword), so treat report 1 as an upper bound and
-- let distinct_source_sets, not the count, decide whether merging is safe.
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
  --     Lineage repository dataset and its table naming. The registry and
  --     direct-dependency table names are assembled from the prefix/suffix -- keep
  --     them in step with 01 setup.

  -- --------------------------------------------------------------------------
  -- [B] BEHAVIOR OPTIONS -- defaults are safe; tune as needed
  -- --------------------------------------------------------------------------
  -- GCP project. Declared here (not in [A]) because it is normally not set by hand:
  -- it is auto-detected in [C] from INFORMATION_SCHEMA.SCHEMATA (the project the job
  -- runs in). To pin it, set a literal in [C].
  DECLARE default_project_id STRING;
  -- Groups listed by report 2 (largest first).
  DECLARE row_limit INT64 DEFAULT 30;
  -- Characters of the representative SQL shown as a sample. Long enough to recognize
  -- the query, short enough to read in a result grid.
  DECLARE sample_length INT64 DEFAULT 240;
  -- Report 3 only: how many of the biggest groups to open up, and how many members of
  -- each to print side by side. Report 3 is the "what actually differs" view -- the
  -- members are printed next to each other so the differing part is visible by eye.
  DECLARE inspect_group_count INT64 DEFAULT 3;
  DECLARE inspect_members_per_group INT64 DEFAULT 5;
  -- MINIMUM LENGTH OF A DIGIT RUN TO FOLD. This is the actual design choice, because
  -- folding from one digit up also merges things that are genuinely different:
  -- `table_v1` and `table_v2` are two tables, and a 6-digit product code is not a
  -- date, while a 20-digit run in a temp table name is a per-run id and nothing else.
  -- The default floor of 10 comes from report 4 on the real registry: it folds the
  -- machine-generated ids and leaves every shorter run alone.
  -- Report 1 reports EVERY threshold in this array, one row each, so the cost of being
  -- cautious is visible instead of assumed. Reports 2 and 3 use detail_min_digit_run.
  DECLARE digit_run_thresholds ARRAY<INT64> DEFAULT [1, 2, 4, 6, 8, 10, 12];
  DECLARE detail_min_digit_run INT64 DEFAULT 10;

  -- --------------------------------------------------------------------------
  -- [C] DERIVED / INTERNAL -- from [A]; DO NOT edit
  -- --------------------------------------------------------------------------
  -- The repository project takes default_project_id (auto-detected below); pin it to
  -- a literal only if the repository lives in a separate project.
  DECLARE repository_project_id STRING DEFAULT NULL;
  DECLARE registry_fqn STRING;
  DECLARE direct_dependency_fqn STRING;
  DECLARE rendered_sql STRING;
  -- Report 1 is assembled per threshold (one CTE and one UNION ALL branch each), so
  -- the digit pattern stays a LITERAL in the generated SQL. A column-valued regex
  -- would be the obvious alternative and is not worth the risk.
  DECLARE threshold_ctes STRING;
  DECLARE threshold_branches STRING;
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
  ASSERT sample_length >= 1 AS 'sample_length must be >= 1.';
  ASSERT row_limit >= 1 AS 'row_limit must be >= 1.';
  ASSERT inspect_group_count >= 1 AS 'inspect_group_count must be >= 1.';
  ASSERT inspect_members_per_group >= 2 AS
    'inspect_members_per_group must be >= 2 (one member alone shows no difference).';
  ASSERT ARRAY_LENGTH(digit_run_thresholds) >= 1 AS
    'digit_run_thresholds must hold at least one threshold.';
  ASSERT NOT EXISTS (
    SELECT 1 FROM UNNEST(digit_run_thresholds) AS t WHERE t < 1
  ) AS 'digit_run_thresholds must all be >= 1.';
  ASSERT detail_min_digit_run >= 1 AS 'detail_min_digit_run must be >= 1.';

  SET registry_fqn = FORMAT(
    '%s.%s.%s',
    repository_project_id,
    repository_dataset,
    table_name_prefix || 'lnge_' || 'm_' || 'definition_registry' || table_name_suffix
  );
  SET direct_dependency_fqn = FORMAT(
    '%s.%s.%s',
    repository_project_id,
    repository_dataset,
    table_name_prefix || 'lnge_' || 't_' || 'direct_dependency' || table_name_suffix
  );

  -- --------------------------------------------------------------------------
  -- Report 1: how much collapse is available, how much of it is lossless, and what
  -- it costs to be cautious about WHICH digits are folded.
  --
  -- ONE ROW PER THRESHOLD in digit_run_thresholds. min_digit_run = 1 folds every
  -- digit run (`table_v1` and `table_v2` become one object, which is wrong if they
  -- are two tables); min_digit_run = 6 folds only runs long enough to be a date or
  -- an epoch. Reading the rows top to bottom shows how much of the collapse survives
  -- the cautious rule -- if the 6 row is close to the 1 row, there is no reason to
  -- take the risk of the 1 row.
  --
  -- objects_now            what STEP 3 analyzes today
  -- groups_after           what it would analyze at this threshold
  -- objects_removable      the difference -- the work that would disappear
  -- lossless_removable     of that, the part whose group members all resolve to the
  --                        SAME source set, so keeping one representative loses nothing
  -- lossy_removable        members that resolve to DIFFERENT source sets: merging
  --                        these WOULD discard lineage edges
  -- unknown_removable      members in groups where nothing has been analyzed yet, so
  --                        neither claim can be made. The three add up to
  --                        objects_removable.
  -- sql_bytes_now/after    total definition length before and after. This is the
  --                        number that predicts STEP 3's runtime, not the object count.
  --
  -- The query is assembled rather than written out: one g_<threshold> CTE and one
  -- UNION ALL branch per threshold, so each digit pattern is a literal. The shared
  -- work (normalizing, joining to the source sets) is done once in `joined`.
  -- --------------------------------------------------------------------------
  SET threshold_ctes = (
    SELECT STRING_AGG(
      FORMAT(
        """
        , g_%d AS (
          SELECT
            REGEXP_REPLACE(norm_base, '[0-9]{%d,}', '#') AS norm_key,
            COUNT(*) AS members,
            COUNT(DISTINCT source_set) AS distinct_source_sets,
            MIN(sql_length) AS keep_sql_bytes
          FROM joined
          GROUP BY 1
        )
        """,
        threshold, threshold
      ),
      ''
      ORDER BY threshold
    )
    FROM UNNEST(digit_run_thresholds) AS threshold
  );

  SET threshold_branches = (
    SELECT STRING_AGG(
      FORMAT(
        """
        SELECT
          %d AS min_digit_run,
          (SELECT objects_now FROM totals) AS objects_now,
          (SELECT COUNT(*) FROM g_%d) AS groups_after,
          (SELECT SUM(members) - COUNT(*) FROM g_%d) AS objects_removable,
          (
            SELECT COALESCE(SUM(members - 1), 0) FROM g_%d
            WHERE members > 1 AND distinct_source_sets = 1
          ) AS lossless_removable,
          (
            SELECT COALESCE(SUM(members - 1), 0) FROM g_%d
            WHERE members > 1 AND distinct_source_sets > 1
          ) AS lossy_removable,
          -- COUNT(DISTINCT source_set) ignores NULLs, so a group no member of which
          -- was ever analyzed scores 0 -- not agreement, just no evidence.
          (
            SELECT COALESCE(SUM(members - 1), 0) FROM g_%d
            WHERE members > 1 AND distinct_source_sets = 0
          ) AS unknown_removable,
          (SELECT sql_bytes_now FROM totals) AS sql_bytes_now,
          (SELECT SUM(keep_sql_bytes) FROM g_%d) AS sql_bytes_after
        """,
        threshold, threshold, threshold, threshold, threshold, threshold, threshold
      ),
      ' UNION ALL '
      ORDER BY threshold
    )
    FROM UNNEST(digit_run_thresholds) AS threshold
  );

  SET rendered_sql = FORMAT(
    """
    WITH base AS (
      SELECT
        object_project, object_dataset, object_name,
        LENGTH(definition_text) AS sql_length,
        -- What the fingerprint already normalizes (backticks, quoted literals,
        -- whitespace, case) -- digits NOT folded yet, that is the per-threshold part.
        UPPER(
          REGEXP_REPLACE(
            REGEXP_REPLACE(
              REPLACE(definition_text, '`', ''),
              "'[^']*'", "'?'"
            ),
            '[[:space:]]+', ' '
          )
        ) AS norm_base
      FROM `%s`
      WHERE is_active = TRUE
        AND is_ephemeral = TRUE
        AND definition_text IS NOT NULL
    ),
    source_sets AS (
      SELECT
        LOWER(target_project) AS object_project,
        LOWER(target_dataset) AS object_dataset,
        LOWER(target_object) AS object_name,
        STRING_AGG(DISTINCT CONCAT(
          COALESCE(LOWER(source_project), ''), '.',
          COALESCE(LOWER(source_dataset), ''), '.',
          LOWER(source_object)
        ), ',' ORDER BY CONCAT(
          COALESCE(LOWER(source_project), ''), '.',
          COALESCE(LOWER(source_dataset), ''), '.',
          LOWER(source_object)
        )) AS source_set
      FROM `%s`
      GROUP BY 1, 2, 3
    ),
    joined AS (
      SELECT b.norm_base, b.sql_length, s.source_set
      FROM base AS b
      LEFT JOIN source_sets AS s
        ON  s.object_project = LOWER(b.object_project)
        AND s.object_dataset = LOWER(b.object_dataset)
        AND s.object_name = LOWER(b.object_name)
    ),
    totals AS (
      SELECT COUNT(*) AS objects_now, SUM(sql_length) AS sql_bytes_now
      FROM joined
    )
    """,
    registry_fqn,
    direct_dependency_fqn
  ) || threshold_ctes || threshold_branches || ' ORDER BY min_digit_run';

  EXECUTE IMMEDIATE rendered_sql;

  -- --------------------------------------------------------------------------
  -- Report 2: the groups themselves, largest first, at detail_min_digit_run.
  --
  -- Read distinct_source_sets first. 1 means the members' lineage is identical, so
  -- keeping one representative loses nothing. More than 1 means they read different
  -- tables and merging would discard edges -- that is the case to look at by hand
  -- before changing the fingerprint. 0 means no member has been analyzed, so there is
  -- no evidence either way.
  --
  -- sample_sql is one member's SQL, truncated. The '#' marks are where digits were.
  -- --------------------------------------------------------------------------
  SET rendered_sql = FORMAT(
    """
    WITH ephemeral AS (
      SELECT
        object_project, object_dataset, object_name,
        definition_text,
        LENGTH(definition_text) AS sql_length,
        -- Report 1's key at the chosen threshold (detail_min_digit_run), so the
        -- groups listed here are the ones that row of report 1 counted.
        UPPER(
          REGEXP_REPLACE(
            REGEXP_REPLACE(
              REGEXP_REPLACE(
                REPLACE(definition_text, '`', ''),
                "'[^']*'", "'?'"
              ),
              '[0-9]{%d,}', '#'
            ),
            '[[:space:]]+', ' '
          )
        ) AS norm_key
      FROM `%s`
      WHERE is_active = TRUE
        AND is_ephemeral = TRUE
        AND definition_text IS NOT NULL
    ),
    source_sets AS (
      SELECT
        LOWER(target_project) AS object_project,
        LOWER(target_dataset) AS object_dataset,
        LOWER(target_object) AS object_name,
        STRING_AGG(DISTINCT CONCAT(
          COALESCE(LOWER(source_project), ''), '.',
          COALESCE(LOWER(source_dataset), ''), '.',
          LOWER(source_object)
        ), ',' ORDER BY CONCAT(
          COALESCE(LOWER(source_project), ''), '.',
          COALESCE(LOWER(source_dataset), ''), '.',
          LOWER(source_object)
        )) AS source_set
      FROM `%s`
      GROUP BY 1, 2, 3
    ),
    joined AS (
      SELECT
        e.norm_key,
        e.object_name,
        e.definition_text,
        e.sql_length,
        s.source_set
      FROM ephemeral AS e
      LEFT JOIN source_sets AS s
        ON  s.object_project = LOWER(e.object_project)
        AND s.object_dataset = LOWER(e.object_dataset)
        AND s.object_name = LOWER(e.object_name)
    )
    SELECT
      COUNT(*) AS members,
      COUNT(DISTINCT source_set) AS distinct_source_sets,
      SUM(sql_length) AS group_sql_bytes,
      MAX(sql_length) AS max_sql_bytes,
      ARRAY_AGG(object_name ORDER BY object_name LIMIT 3) AS example_objects,
      SUBSTR(
        REGEXP_REPLACE(
          ARRAY_AGG(definition_text ORDER BY object_name LIMIT 1)[SAFE_OFFSET(0)],
          '[[:space:]]+', ' '
        ),
        1, @sample_len
      ) AS sample_sql
    FROM joined
    GROUP BY norm_key
    HAVING members > 1
    ORDER BY members DESC, group_sql_bytes DESC
    LIMIT @max_rows
    """,
    detail_min_digit_run,
    registry_fqn,
    direct_dependency_fqn
  );

  EXECUTE IMMEDIATE rendered_sql
  USING sample_length AS sample_len, row_limit AS max_rows;

  -- --------------------------------------------------------------------------
  -- Report 3: the biggest groups opened up, member by member.
  --
  -- Reports 1 and 2 say HOW MUCH would collapse; this one says WHAT DIFFERS. The
  -- members of each group are printed one per row with their SQL heads aligned, so
  -- scanning down the sql_text column shows the varying part -- a date-suffixed table
  -- name, a partition id, a run number. That is the thing a digit-aware fingerprint
  -- would absorb.
  --
  -- If the rows look IDENTICAL within the sample window, the difference is further
  -- into the SQL: raise sample_length and run again.
  -- --------------------------------------------------------------------------
  SET rendered_sql = FORMAT(
    """
    WITH ephemeral AS (
      SELECT
        object_name,
        definition_text,
        LENGTH(definition_text) AS sql_length,
        -- Same key as report 2, at detail_min_digit_run.
        UPPER(
          REGEXP_REPLACE(
            REGEXP_REPLACE(
              REGEXP_REPLACE(
                REPLACE(definition_text, '`', ''),
                "'[^']*'", "'?'"
              ),
              '[0-9]{%d,}', '#'
            ),
            '[[:space:]]+', ' '
          )
        ) AS norm_key
      FROM `%s`
      WHERE is_active = TRUE
        AND is_ephemeral = TRUE
        AND definition_text IS NOT NULL
    ),
    -- NOT named `groups`: GROUPS is a GoogleSQL reserved keyword (the window-frame
    -- unit in ROWS | RANGE | GROUPS), so a CTE by that name is a syntax error.
    group_sizes AS (
      SELECT norm_key, COUNT(*) AS member_count
      FROM ephemeral
      GROUP BY norm_key
      HAVING COUNT(*) > 1
    ),
    top_groups AS (
      SELECT
        norm_key AS group_key,
        member_count,
        -- ROW_NUMBER, not RANK: a tie must not drag in an unbounded number of groups.
        ROW_NUMBER() OVER (ORDER BY member_count DESC, norm_key) AS group_no
      FROM group_sizes
    ),
    picked AS (
      SELECT
        g.group_no,
        g.member_count,
        e.object_name,
        e.sql_length,
        e.definition_text,
        ROW_NUMBER() OVER (PARTITION BY g.group_no ORDER BY e.object_name) AS member_no
      FROM ephemeral AS e
      INNER JOIN top_groups AS g
        ON g.group_key = e.norm_key
      WHERE g.group_no <= @group_count
    )
    SELECT
      group_no,
      member_count,
      member_no,
      object_name,
      sql_length,
      SUBSTR(REGEXP_REPLACE(definition_text, '[[:space:]]+', ' '), 1, @sample_len)
        AS sql_text
    FROM picked
    WHERE member_no <= @members_each
    ORDER BY group_no, member_no
    """,
    detail_min_digit_run,
    registry_fqn
  );

  EXECUTE IMMEDIATE rendered_sql
  USING
    sample_length AS sample_len,
    inspect_group_count AS group_count,
    inspect_members_per_group AS members_each;

  -- --------------------------------------------------------------------------
  -- Report 4: what the digits actually ARE -- a census of the digit runs that
  -- appear INSIDE identifier-shaped tokens, by run length.
  --
  -- This is the report that decides the rule, because a length threshold cannot
  -- tell a date from a product code. A run of 6 digits is `202601` (a month),
  -- `260101` (a two-digit-year date) or `123456` (a code), and folding the last one
  -- merges two genuinely different objects. Report 1 says how MUCH each threshold
  -- collapses; this says WHETHER it should.
  --
  -- THE THREE SHAPE COUNTS, which is how a code is told from a date:
  --   date_century  (19|20)YY, month 01-12, optional day 01-31 -- so 6 or 8 digits
  --                 with a century. `202601` and `20260101` match; `123456` does not.
  --   date_yy_mmdd  YYMMDD without a century: any 2 digits, then a valid month and a
  --                 valid day. `260101` matches.
  --   neither       everything else.
  -- A RANDOM 6-digit number passes date_yy_mmdd by chance about 4% of the time
  -- (12/100 for the month times 31/100 for the day), so this count separates the two
  -- readings cleanly: near 100% means dates, near 4% means codes that happen to land
  -- on a valid month and day.
  --
  -- distinct_year_prefix is the second, independent check: dates drawn from a lookback
  -- window share a handful of leading 2-digit values (one or two years), while codes
  -- spread across many. min_value / max_value bound the range for the same reason.
  --
  -- sample_values and sample_identifiers are plain comma-joined STRINGS, not ARRAYs,
  -- so they can be read (and pasted) straight out of the result grid. The identifier
  -- samples carry real object names: they are for looking at, not for sharing.
  --
  -- Identifier-shaped means a token starting with a letter or underscore, so digits
  -- in numeric literals and in quoted strings are not counted -- the fingerprint
  -- already folds those as literals and they cannot explain a surviving duplicate.
  -- A dotted path in backticks (`project.dataset.events_20260101`) is split on the
  -- dots, which is fine: each part is still an identifier.
  -- --------------------------------------------------------------------------
  SET rendered_sql = FORMAT(
    """
    WITH ephemeral AS (
      SELECT definition_text
      FROM `%s`
      WHERE is_active = TRUE
        AND is_ephemeral = TRUE
        AND definition_text IS NOT NULL
    ),
    identifier_runs AS (
      SELECT
        identifier,
        digit_run
      FROM ephemeral,
        UNNEST(REGEXP_EXTRACT_ALL(definition_text, '[A-Za-z_][A-Za-z0-9_]*'))
          AS identifier,
        UNNEST(REGEXP_EXTRACT_ALL(identifier, '[0-9]+')) AS digit_run
    )
    SELECT
      LENGTH(digit_run) AS digit_run_length,
      COUNT(*) AS occurrences,
      COUNT(DISTINCT digit_run) AS distinct_values,
      COUNTIF(
        REGEXP_CONTAINS(
          digit_run,
          '^(19|20)[0-9][0-9](0[1-9]|1[0-2])(0[1-9]|[12][0-9]|3[01])?$'
        )
      ) AS date_century,
      COUNTIF(
        REGEXP_CONTAINS(
          digit_run,
          '^[0-9][0-9](0[1-9]|1[0-2])(0[1-9]|[12][0-9]|3[01])$'
        )
      ) AS date_yy_mmdd,
      COUNT(DISTINCT SUBSTR(digit_run, 1, 2)) AS distinct_year_prefix,
      MIN(digit_run) AS min_value,
      MAX(digit_run) AS max_value,
      ARRAY_TO_STRING(
        ARRAY_AGG(DISTINCT digit_run ORDER BY digit_run LIMIT 10), ' '
      ) AS sample_values,
      ARRAY_TO_STRING(
        ARRAY_AGG(DISTINCT identifier ORDER BY identifier LIMIT 5), ' '
      ) AS sample_identifiers
    FROM identifier_runs
    GROUP BY digit_run_length
    ORDER BY digit_run_length
    """,
    registry_fqn
  );

  EXECUTE IMMEDIATE rendered_sql;
END;
