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
-- cause is a date-suffixed identifier (events_20260101 vs events_20260102), which
-- the tokenizer sees as one IDENTIFIER token and the fingerprint keeps intact.
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
-- differs between them is visible by eye rather than inferred.
--
-- Read-only report; changes nothing. Run it to decide whether extending
-- fingerprintSqlForBigQuery is worth the one-off re-registration it would cause
-- (the ephemeral definition_hash IS the fingerprint, so changing it re-identifies
-- every ephemeral object once).
--
-- NOTE ON THE NORMALIZATION: the key re-does on raw text what the fingerprint does on
-- tokens (strip backticks, collapse quoted literals to '?', collapse whitespace,
-- uppercase) and then folds digit runs to '#'. The fingerprint's own normalizations
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

  -- --------------------------------------------------------------------------
  -- [C] DERIVED / INTERNAL -- from [A]; DO NOT edit
  -- --------------------------------------------------------------------------
  -- The repository project takes default_project_id (auto-detected below); pin it to
  -- a literal only if the repository lives in a separate project.
  DECLARE repository_project_id STRING DEFAULT NULL;
  DECLARE registry_fqn STRING;
  DECLARE direct_dependency_fqn STRING;
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
  -- Report 1: how much collapse is available, and how much of it is lossless.
  --
  -- objects_now            what STEP 3 analyzes today
  -- groups_after           what it would analyze if identifier digits were folded
  -- objects_removable      the difference -- the work that would disappear
  -- lossless_removable     of that, the part whose group members all resolve to the
  --                        SAME source set, so keeping one representative loses nothing
  -- lossy_removable        members that resolve to DIFFERENT source sets: merging
  --                        these WOULD discard lineage edges
  -- unknown_removable      members in groups where nothing has been analyzed yet, so
  --                        neither claim can be made. The three add up to
  --                        objects_removable.
  -- --------------------------------------------------------------------------
  SET rendered_sql = FORMAT(
    """
    WITH ephemeral AS (
      SELECT
        object_project, object_dataset, object_name, object_type,
        definition_text,
        LENGTH(definition_text) AS sql_length,
        -- The measurement key: what the fingerprint already normalizes (backticks,
        -- quoted literals, whitespace, case) PLUS digit runs inside identifiers.
        -- Built in that order so events_20260101 -> EVENTS_#. See the header note.
        UPPER(
          REGEXP_REPLACE(
            REGEXP_REPLACE(
              REGEXP_REPLACE(
                REPLACE(definition_text, '`', ''),
                "'[^']*'", "'?'"
              ),
              '[0-9]+', '#'
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
      SELECT e.norm_key, e.sql_length, s.source_set
      FROM ephemeral AS e
      LEFT JOIN source_sets AS s
        ON  s.object_project = LOWER(e.object_project)
        AND s.object_dataset = LOWER(e.object_dataset)
        AND s.object_name = LOWER(e.object_name)
    ),
    grouped AS (
      SELECT
        norm_key,
        COUNT(*) AS members,
        COUNT(DISTINCT source_set) AS distinct_source_sets,
        SUM(sql_length) AS group_sql_bytes,
        MIN(sql_length) AS keep_sql_bytes
      FROM joined
      GROUP BY norm_key
    )
    SELECT
      (SELECT COUNT(*) FROM ephemeral) AS objects_now,
      (SELECT COUNT(*) FROM grouped) AS groups_after,
      (SELECT SUM(members) - COUNT(*) FROM grouped) AS objects_removable,
      (
        SELECT COALESCE(SUM(members - 1), 0)
        FROM grouped
        WHERE members > 1 AND distinct_source_sets = 1
      ) AS lossless_removable,
      (
        SELECT COALESCE(SUM(members - 1), 0)
        FROM grouped
        WHERE members > 1 AND distinct_source_sets > 1
      ) AS lossy_removable,
      -- COUNT(DISTINCT source_set) ignores NULLs, so a group no member of which was
      -- ever analyzed scores 0 -- not evidence of agreement, just no evidence.
      (
        SELECT COALESCE(SUM(members - 1), 0)
        FROM grouped
        WHERE members > 1 AND distinct_source_sets = 0
      ) AS unknown_removable,
      (SELECT SUM(sql_length) FROM ephemeral) AS sql_bytes_now,
      (SELECT SUM(keep_sql_bytes) FROM grouped) AS sql_bytes_after
    """,
    registry_fqn,
    direct_dependency_fqn
  );

  EXECUTE IMMEDIATE rendered_sql;

  -- --------------------------------------------------------------------------
  -- Report 2: the groups themselves, largest first.
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
        -- Same key as report 1 -- keep the two in step.
        UPPER(
          REGEXP_REPLACE(
            REGEXP_REPLACE(
              REGEXP_REPLACE(
                REPLACE(definition_text, '`', ''),
                "'[^']*'", "'?'"
              ),
              '[0-9]+', '#'
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
        -- Same key as reports 1 and 2 -- keep the three in step.
        UPPER(
          REGEXP_REPLACE(
            REGEXP_REPLACE(
              REGEXP_REPLACE(
                REPLACE(definition_text, '`', ''),
                "'[^']*'", "'?'"
              ),
              '[0-9]+', '#'
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
    registry_fqn
  );

  EXECUTE IMMEDIATE rendered_sql
  USING
    sample_length AS sample_len,
    inspect_group_count AS group_count,
    inspect_members_per_group AS members_each;
END;
