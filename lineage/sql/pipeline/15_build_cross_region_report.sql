-- ============================================================================
-- 15_build_cross_region_report.sql
-- BigQuery Physical Lineage Repository - Combine every region's report tables
-- ============================================================================
-- The other half of the cross-region report. Run this in the HOST region -- the one
-- whose bucket 14_export_report_tables.sql writes into -- after every other region
-- has exported.
--
-- WHAT IT PRODUCES: one table per report, holding every region's rows, clustered so
-- that a dataset filter prunes. Point Looker Studio at these and the blend
-- disappears: one data source, one scan, filters that reach the table.
--
--   <report_dataset>.lnge_t_column_usage_impact   <- the Looker Studio data source
--   <report_dataset>.lnge_t_object_dependency
--
-- WHY A SEPARATE TABLE AND NOT THE HOST REGION'S OWN. 03 STEP 4b owns
-- lnge_t_column_usage_impact in the repository dataset and rebuilds it with
-- CREATE OR REPLACE from LOCAL rows only. Loading other regions into that table
-- would work until the next 03 run wiped them, and 03 runs daily and gets re-run.
-- Keeping the combined table separate leaves each region's table as its own atomic
-- truth, makes this script's output purely derived, and keeps 03 region-agnostic.
--
-- THE HOST REGION IS READ LOCALLY. It needs no export and no Cloud Storage round
-- trip: its table is in this region already. Only the regions in remote_regions
-- come through Parquet.
--
-- CLUSTERING. The combined table is clustered on origin_dataset first, because that
-- is what the report filters on. Pruning needs a PREFIX of the clustering columns,
-- so a leading column that is never filtered -- origin_project, single-valued here --
-- would spend the first key for nothing. source_region is carried as a column but is
-- not a clustering key: it exists to show WHICH region a row came from and how fresh
-- that region is, not to be filtered on.
--
-- IT CHECKS BEFORE IT PUBLISHES. The combined table is only replaced once every
-- source has passed:
--   * no source older than max_staleness_hours. Reported, and a hard stop only when
--     fail_on_stale is TRUE; by default a stale region is surfaced while the report
--     keeps working.
--   * one distinct updated_at per source. More than one means shards from more than
--     one export sit under that prefix, because `*` shards the export by size and
--     overwrite may not remove the extra files a LARGER previous run produced. This
--     is reported, not fatal: the union reads only the newest updated_at per source,
--     so leftovers cannot reach the published table. Correctness does not depend on
--     what overwrite does -- only tidiness of the bucket does.
-- A missing export fails the check query itself, which is the intended behavior:
-- better than publishing a report with a region quietly absent.
--
-- VERSION LOCK: the union uses SELECT *, so every region must run the same 01/03 and
-- the same static_tables_include_usage_sql -- that flag adds or drops two columns.
-- A mismatch fails here rather than producing a table with the wrong shape.
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
  -- Datasets (local repository / combined report output)
  DECLARE repository_dataset STRING DEFAULT 'lineage_repository';
  DECLARE report_dataset STRING DEFAULT 'lineage_report';
  -- Table naming
  DECLARE table_name_prefix STRING DEFAULT '';
  DECLARE table_name_suffix STRING DEFAULT '';
  -- Cross-region input (must match 14's export_uri_prefix)
  DECLARE export_uri_prefix STRING DEFAULT 'gs://YOUR_BUCKET/lineage/cross_region';
  DECLARE remote_regions ARRAY<STRING> DEFAULT ['us-central1', 'europe-west1'];
  --
  -- Variable notes (keyed by name):
  --   project_token_pattern
  --     Project-token substitution regex (keep in step with 01). A token extracted
  --     from the auto-detected project id replaces every '{project_token}'
  --     placeholder in the dataset names, the table prefix/suffix and the URI.
  --   repository_dataset
  --     Where 03 wrote THIS region's static report tables. Read, never written.
  --   report_dataset
  --     Where the combined tables and the external tables over Cloud Storage are
  --     created. This script owns everything in it, so it is created here if
  --     missing -- unlike 03, which refuses to re-create repository tables it does
  --     not own. Keep it separate from repository_dataset so 03 and this script
  --     never write to the same place.
  --   table_name_prefix / table_name_suffix
  --     Applied to both the local and the combined table names, so the combined
  --     table keeps the same name as the per-region one and a Looker Studio data
  --     source can be re-pointed without renaming fields.
  --   export_uri_prefix
  --     Must be byte-identical to 14's export_uri_prefix: this script addresses
  --     <prefix>/<region>/<table>/*.parquet for each remote region.
  --   remote_regions
  --     Every region EXCEPT this one. This region is read locally from
  --     repository_dataset; listing it here would read it twice. Adding a region
  --     means deploying 14 there and adding it to this list -- nothing else.

  -- --------------------------------------------------------------------------
  -- [B] BEHAVIOR OPTIONS -- defaults are safe; tune as needed
  -- --------------------------------------------------------------------------
  -- GCP project. Declared here (not in [A]) because it is normally not set by hand:
  -- it is auto-detected in [C] from INFORMATION_SCHEMA.SCHEMATA (the project the job
  -- runs in). To pin it, set a literal in [C].
  DECLARE default_project_id STRING;
  -- Combine the object-level dependency table as well. Keep it in step with 14's
  -- include_object_dependency.
  DECLARE include_object_dependency BOOL DEFAULT TRUE;
  -- A source whose updated_at is older than this is reported as stale.
  DECLARE max_staleness_hours INT64 DEFAULT 36;
  -- TRUE stops the run on a stale source instead of publishing it with a warning.
  DECLARE fail_on_stale BOOL DEFAULT FALSE;

  -- --------------------------------------------------------------------------
  -- [C] DERIVED / INTERNAL -- from [A]; DO NOT edit
  -- --------------------------------------------------------------------------
  -- The repository project takes default_project_id (auto-detected below); pin it
  -- to a literal only if the repository lives in a separate project.
  DECLARE repository_project_id STRING DEFAULT NULL;
  DECLARE project_token STRING;
  -- This region: read locally, and the source_region value for its own rows.
  DECLARE host_region STRING;
  DECLARE usage_impact_base STRING;
  DECLARE object_dependency_base STRING;
  -- External-table names, rebuilt per region inside the loop. Assembled as
  -- prefix + 'lnge_' + marker + base + suffix so the suffix stays at the end.
  DECLARE src_usage_name STRING;
  DECLARE src_dependency_name STRING;
  DECLARE union_usage_impact_sql STRING;
  DECLARE union_object_dependency_sql STRING;
  DECLARE freshness_sql STRING;
  DECLARE rendered_sql STRING;
  DECLARE stale_source_count INT64 DEFAULT 0;
  DECLARE mixed_export_count INT64 DEFAULT 0;
  DECLARE offending_sources STRING;

  EXECUTE IMMEDIATE FORMAT(
    "SELECT DISTINCT catalog_name FROM `region-%s`.INFORMATION_SCHEMA.SCHEMATA LIMIT 1",
    @@location
  ) INTO default_project_id;
  ASSERT default_project_id IS NOT NULL AS
    'Could not auto-detect the project id from INFORMATION_SCHEMA.SCHEMATA; set default_project_id to a literal.';
  SET repository_project_id = COALESCE(repository_project_id, default_project_id);
  SET host_region = LOWER(@@location);
  SET project_token =
    COALESCE(REGEXP_EXTRACT(default_project_id, project_token_pattern), '');
  SET repository_dataset =
    REPLACE(repository_dataset, '{project_token}', project_token);
  SET report_dataset =
    REPLACE(report_dataset, '{project_token}', project_token);
  SET table_name_prefix =
    REPLACE(table_name_prefix, '{project_token}', project_token);
  SET table_name_suffix =
    REPLACE(table_name_suffix, '{project_token}', project_token);
  SET export_uri_prefix =
    REPLACE(export_uri_prefix, '{project_token}', project_token);

  ASSERT REGEXP_CONTAINS(repository_dataset, r'^[A-Za-z0-9_]+$')
    AS 'repository_dataset must be letters/digits/underscore only (check for an unsubstituted {project_token}).';
  ASSERT REGEXP_CONTAINS(report_dataset, r'^[A-Za-z0-9_]+$')
    AS 'report_dataset must be letters/digits/underscore only (check for an unsubstituted {project_token}).';
  ASSERT report_dataset != repository_dataset
    AS 'report_dataset must differ from repository_dataset: 03 owns the repository copies and would overwrite the combined table.';
  ASSERT REGEXP_CONTAINS(export_uri_prefix, r'^gs://[A-Za-z0-9._-]+(/[A-Za-z0-9._-]+)*$')
    AS 'export_uri_prefix must be gs://bucket[/path] with no trailing slash and no unsubstituted {project_token}.';
  ASSERT ARRAY_LENGTH(remote_regions) > 0
    AS 'remote_regions is empty: with only this region there is nothing to combine -- read the repository table directly.';
  ASSERT NOT EXISTS (
    SELECT 1 FROM UNNEST(remote_regions) AS r WHERE LOWER(r) = host_region
  ) AS 'remote_regions must not contain this region: it is read locally and would be counted twice.';
  ASSERT NOT EXISTS (
    SELECT 1 FROM UNNEST(remote_regions) AS r WHERE NOT REGEXP_CONTAINS(r, r'^[a-z0-9-]+$')
  ) AS 'Each remote region must be lowercase letters/digits/hyphen: it is both a Cloud Storage path segment and part of a table name.';
  ASSERT max_staleness_hours >= 1 AS 'max_staleness_hours must be >= 1.';

  SET usage_impact_base =
    table_name_prefix || 'lnge_' || 't_' || 'column_usage_impact' || table_name_suffix;
  SET object_dependency_base =
    table_name_prefix || 'lnge_' || 't_' || 'object_dependency' || table_name_suffix;

  -- --------------------------------------------------------------------------
  -- STEP 1: the output dataset.
  --
  -- Created here, not in 01: this script is the only writer, and the combined report
  -- is a reporting concern rather than part of the repository 01 bootstraps.
  -- --------------------------------------------------------------------------
  SELECT '===== STEP 1: ensure the report dataset =====' AS processing_step;

  EXECUTE IMMEDIATE FORMAT(
    "CREATE SCHEMA IF NOT EXISTS `%s.%s` OPTIONS (location = '%s')",
    repository_project_id, report_dataset, host_region
  );

  -- --------------------------------------------------------------------------
  -- STEP 2: an external table per remote region, over its exported Parquet.
  --
  -- Parquet self-describes, so no schema is declared -- which also means a region
  -- running a different 01/03 shows up as a column mismatch in STEP 4 rather than
  -- as silently wrong data. CREATE OR REPLACE every run keeps the definitions in
  -- step with [A] and costs nothing: an external table holds no data.
  -- --------------------------------------------------------------------------
  SELECT '===== STEP 2: external tables over the exported Parquet =====' AS processing_step;

  -- The host region is the first branch of both unions and is read locally.
  SET union_usage_impact_sql = FORMAT(
    "SELECT '%s' AS source_region, * FROM `%s.%s.%s`",
    host_region, repository_project_id, repository_dataset, usage_impact_base
  );
  SET union_object_dependency_sql = FORMAT(
    "SELECT '%s' AS source_region, * FROM `%s.%s.%s`",
    host_region, repository_project_id, repository_dataset, object_dependency_base
  );
  SET freshness_sql = FORMAT(
    """
    SELECT
      '%s' AS source_region,
      COUNT(*) AS row_count,
      COUNT(DISTINCT updated_at) AS distinct_updated_at,
      MAX(updated_at) AS newest_updated_at
    FROM `%s.%s.%s`
    """,
    host_region, repository_project_id, repository_dataset, usage_impact_base
  );

  FOR region_row IN (
    SELECT LOWER(r) AS region, REPLACE(LOWER(r), '-', '_') AS region_token
    FROM UNNEST(remote_regions) AS r
    ORDER BY 1
  ) DO
    SET src_usage_name = table_name_prefix || 'lnge_' || 't_'
      || 'column_usage_impact_src_' || region_row.region_token || table_name_suffix;
    SET src_dependency_name = table_name_prefix || 'lnge_' || 't_'
      || 'object_dependency_src_' || region_row.region_token || table_name_suffix;

    EXECUTE IMMEDIATE FORMAT(
      """
      CREATE OR REPLACE EXTERNAL TABLE `%s.%s.%s`
      OPTIONS (
        format = 'PARQUET',
        uris = ['%s/%s/column_usage_impact/*.parquet']
      )
      """,
      repository_project_id, report_dataset, src_usage_name,
      export_uri_prefix, region_row.region
    );

    -- Only the newest export is read. `*` in the export URI shards by size, and
    -- whether overwrite deletes shards from a LARGER previous run is not something
    -- to depend on: every row of one 03 rebuild carries the same updated_at, so
    -- leftover shards carry the older one and drop out here. The host branch above
    -- needs no such filter -- 03 owns that table and replaces it whole.
    SET union_usage_impact_sql = union_usage_impact_sql || FORMAT(
      """

      UNION ALL
      SELECT '%s' AS source_region, *
      FROM `%s.%s.%s`
      WHERE updated_at = (SELECT MAX(updated_at) FROM `%s.%s.%s`)""",
      region_row.region,
      repository_project_id, report_dataset, src_usage_name,
      repository_project_id, report_dataset, src_usage_name
    );

    SET freshness_sql = freshness_sql || FORMAT(
      """
      UNION ALL
      SELECT
        '%s' AS source_region,
        COUNT(*) AS row_count,
        COUNT(DISTINCT updated_at) AS distinct_updated_at,
        MAX(updated_at) AS newest_updated_at
      FROM `%s.%s.%s`
      """,
      region_row.region,
      repository_project_id, report_dataset, src_usage_name
    );

    IF include_object_dependency THEN
      EXECUTE IMMEDIATE FORMAT(
        """
        CREATE OR REPLACE EXTERNAL TABLE `%s.%s.%s`
        OPTIONS (
          format = 'PARQUET',
          uris = ['%s/%s/object_dependency/*.parquet']
        )
        """,
        repository_project_id, report_dataset, src_dependency_name,
        export_uri_prefix, region_row.region
      );

      SET union_object_dependency_sql = union_object_dependency_sql || FORMAT(
        """

        UNION ALL
        SELECT '%s' AS source_region, *
        FROM `%s.%s.%s`
        WHERE updated_at = (SELECT MAX(updated_at) FROM `%s.%s.%s`)""",
        region_row.region,
        repository_project_id, report_dataset, src_dependency_name,
        repository_project_id, report_dataset, src_dependency_name
      );
    END IF;
  END FOR;

  -- --------------------------------------------------------------------------
  -- STEP 3: check every source BEFORE publishing.
  --
  -- Reading the external tables here is also what proves the exports exist: a
  -- missing file set fails this query, which is the point -- a region must not go
  -- quietly absent from the report.
  -- --------------------------------------------------------------------------
  SELECT '===== STEP 3: verify the sources =====' AS processing_step;

  EXECUTE IMMEDIATE FORMAT(
    """
    CREATE OR REPLACE TEMP TABLE source_freshness AS
    SELECT
      source_region,
      row_count,
      distinct_updated_at,
      newest_updated_at,
      TIMESTAMP_DIFF(CURRENT_TIMESTAMP(), newest_updated_at, HOUR) AS age_hours,
      (TIMESTAMP_DIFF(CURRENT_TIMESTAMP(), newest_updated_at, HOUR) > @max_age) AS is_stale,
      (distinct_updated_at > 1) AS is_mixed_export
    FROM (%s)
    """,
    freshness_sql
  ) USING max_staleness_hours AS max_age;

  SELECT * FROM source_freshness ORDER BY source_region;

  SET mixed_export_count = (SELECT COUNTIF(is_mixed_export) FROM source_freshness);
  IF mixed_export_count > 0 THEN
    SET offending_sources = (
      SELECT STRING_AGG(source_region, ', ' ORDER BY source_region)
      FROM source_freshness WHERE is_mixed_export
    );
    -- More than one updated_at in one source means shards from more than one export
    -- are sitting under that prefix: a previous, larger export left files behind.
    -- The union reads only the newest updated_at, so the published rows are right
    -- either way -- this is reported rather than fatal, because the condition is
    -- untidy storage, not wrong data. Row counts here still include the leftovers.
    SELECT
      'LEFTOVER_EXPORT_SHARDS' AS step_name,
      'WARNING' AS status,
      offending_sources AS affected_sources,
      'Shards from an earlier export remain under <export_uri_prefix>/<region>/. The combined table is still correct: only the newest updated_at per source is read. To clear it, delete the objects under those prefixes and let 14 re-export.' AS note;
  END IF;

  SET stale_source_count = (SELECT COUNTIF(is_stale) FROM source_freshness);
  IF stale_source_count > 0 THEN
    SET offending_sources = (
      SELECT STRING_AGG(FORMAT('%s (%d h)', source_region, age_hours), ', ' ORDER BY source_region)
      FROM source_freshness WHERE is_stale
    );
    IF fail_on_stale THEN
      RAISE USING MESSAGE = FORMAT(
        'Source region(s) %s are older than max_staleness_hours. Check that 03 and 14 ran there. The combined table was NOT replaced.',
        offending_sources
      );
    END IF;
    SELECT
      'STALE_SOURCE' AS step_name,
      'WARNING' AS status,
      offending_sources AS stale_sources,
      'Published anyway (fail_on_stale = FALSE). source_region and updated_at are columns of the combined table, so the report can show which region is behind.' AS note;
  END IF;

  -- --------------------------------------------------------------------------
  -- STEP 4: publish the combined tables.
  --
  -- CLUSTER BY leads with origin_dataset because that is the report's filter;
  -- origin_project is left out on purpose (single-valued, never filtered, and a
  -- leading key that is never used buys nothing because pruning needs a prefix).
  -- --------------------------------------------------------------------------
  SELECT '===== STEP 4: publish the combined report tables =====' AS processing_step;

  EXECUTE IMMEDIATE FORMAT(
    """
    CREATE OR REPLACE TABLE `%s.%s.%s`
    CLUSTER BY origin_dataset, origin_object, origin_column
    OPTIONS (
      description = 'All regions column usage x impact rows in one table, rebuilt by 15_build_cross_region_report.sql. source_region names the region a row came from, and updated_at is the timestamp of the 03 run in that region, so a region that is behind is visible rather than silently old. Clustered on origin_dataset first because that is what the report filters on. Derived table: the per-region copy in each repository dataset is the truth, and this one is replaced wholesale on every run.'
    )
    AS
    %s
    """,
    repository_project_id, report_dataset, usage_impact_base,
    union_usage_impact_sql
  );

  IF include_object_dependency THEN
    EXECUTE IMMEDIATE FORMAT(
      """
      CREATE OR REPLACE TABLE `%s.%s.%s`
      CLUSTER BY origin_dataset, origin_object
      OPTIONS (
        description = 'All regions object-level dependency rows in one table, rebuilt by 15_build_cross_region_report.sql. source_region names the region a row came from. Clustered on origin_dataset first because that is what the report filters on. Derived table: the per-region copy in each repository dataset is the truth.'
      )
      AS
      %s
      """,
      repository_project_id, report_dataset, object_dependency_base,
      union_object_dependency_sql
    );
  END IF;

  -- --------------------------------------------------------------------------
  -- Summary.
  -- --------------------------------------------------------------------------
  EXECUTE IMMEDIATE FORMAT(
    """
    SELECT
      'BUILD_CROSS_REGION_REPORT' AS step_name,
      'COMPLETED' AS status,
      @regions AS combined_regions,
      (SELECT COUNT(*) FROM `%s.%s.%s`) AS column_usage_impact_rows,
      (SELECT COUNT(DISTINCT source_region) FROM `%s.%s.%s`) AS source_region_count,
      @stale AS stale_source_count
    """,
    repository_project_id, report_dataset, usage_impact_base,
    repository_project_id, report_dataset, usage_impact_base
  )
  USING
    ARRAY_LENGTH(remote_regions) + 1 AS regions,
    stale_source_count AS stale;

EXCEPTION WHEN ERROR THEN
  SELECT
    'BUILD_CROSS_REGION_REPORT' AS step_name,
    'FAILED' AS status,
    @@error.message AS error_message,
    'Common causes: a region in remote_regions has not run 14 yet (no Parquet under <export_uri_prefix>/<region>/); export_uri_prefix does not match the value 14 uses; or a region runs a different 01/03 or a different static_tables_include_usage_sql, which changes the column set and breaks the UNION. The combined tables keep their previous contents when this fails.' AS hint;
  RAISE USING MESSAGE = @@error.message;
END;
