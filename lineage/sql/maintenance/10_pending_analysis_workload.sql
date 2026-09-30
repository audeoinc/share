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

  -- --------------------------------------------------------------------------
  -- [C] DERIVED / INTERNAL -- from [A]; DO NOT edit
  -- --------------------------------------------------------------------------
  -- The repository project takes default_project_id (auto-detected below); pin it
  -- to a literal only if the repository lives in a separate project.
  DECLARE repository_project_id STRING DEFAULT NULL;
  DECLARE registry_fqn STRING;
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

  SET registry_fqn = FORMAT(
    '%s.%s.%s',
    repository_project_id,
    repository_dataset,
    table_name_prefix || 'lnge_' || 'm_' || 'definition_registry' || table_name_suffix
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
END;
