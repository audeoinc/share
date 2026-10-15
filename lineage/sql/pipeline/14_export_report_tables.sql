-- ============================================================================
-- 14_export_report_tables.sql
-- BigQuery Physical Lineage Repository - Export the report tables for one region
-- ============================================================================
-- Half of the cross-region report. Run this in EVERY region EXCEPT the one that
-- hosts the combined report; 15_build_cross_region_report.sql then reads what this
-- writes and unions it with the host region's own tables.
--
-- WHY THIS EXISTS: a BigQuery query reads datasets in ONE region, so a report that
-- covers every region cannot be a query -- the rows have to be physically brought
-- together first. Doing the union in Looker Studio instead (a blend) moves the join
-- into the BI layer, where a filter no longer reaches the table scan: clustering
-- cannot prune and the page gets slower with every region added.
--
-- WHAT IT DOES: exports 03's two static report tables to Parquet in Cloud Storage,
-- under a per-region prefix. Nothing else is exported -- the registry and the job
-- history stay in their own region.
--
-- PARQUET IS NOT OPTIONAL. lnge_t_column_usage_impact carries
-- dependency_path ARRAY<STRING> and lnge_t_object_dependency carries
-- column_dependencies ARRAY<STRUCT<...>>. CSV cannot represent either and the export
-- fails outright; Parquet carries them natively and self-describes its schema, so
-- the reading side needs no schema definition.
--
-- THE BUCKET BELONGS TO THE HOST REGION, NOT TO THIS ONE. Exporting straight into
-- the host region's bucket is what removes the need to copy objects between buckets,
-- which no SQL statement can do. Verify a cross-region export is permitted in your
-- project before relying on this (a one-line probe:
-- EXPORT DATA OPTIONS(uri='gs://<host bucket>/probe/*.parquet', format='PARQUET',
-- overwrite=true) AS SELECT 1 AS probe).
--
-- SCHEDULING: run it after 03 finishes in this region, and far enough before 15 that
-- the export has completed. 15 does not trust that timing -- it checks freshness from
-- the data itself -- but a late export still means a late report.
--
-- STALE SHARDS: overwrite = TRUE replaces the files under the URI pattern. If a run
-- ever leaves shards from a LARGER previous export behind, the reader would see one
-- region twice. 15 detects exactly that (every row of one export carries the same
-- updated_at, so two values for one region means two exports are being read) and
-- stops. Do not remove that check.
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
  -- Cloud Storage destination (a bucket in the HOST region)
  DECLARE export_uri_prefix STRING DEFAULT 'gs://YOUR_BUCKET/lineage/cross_region';
  --
  -- Variable notes (keyed by name):
  --   project_token_pattern
  --     Project-token substitution regex (keep in step with 01). A token extracted
  --     from the auto-detected project id replaces every '{project_token}'
  --     placeholder in the dataset name and the table prefix/suffix. Default: first
  --     hyphen segment.
  --   repository_dataset / table_name_prefix / table_name_suffix
  --     Where 03 wrote the static report tables in THIS region. Keep them in step
  --     with 01 and 03; the physical table names are assembled from them.
  --   export_uri_prefix
  --     Cloud Storage prefix, no trailing slash. The bucket must be the one
  --     15_build_cross_region_report.sql reads, which means it must be in the HOST
  --     region -- not in this one. Files land under
  --     <prefix>/<this region>/<table>/ so the regions never overwrite each other,
  --     and the region segment is what 15 uses to address them.

  -- --------------------------------------------------------------------------
  -- [B] BEHAVIOR OPTIONS -- defaults are safe; tune as needed
  -- --------------------------------------------------------------------------
  -- GCP project. Declared here (not in [A]) because it is normally not set by hand:
  -- it is auto-detected in [C] from INFORMATION_SCHEMA.SCHEMATA (the project the job
  -- runs in). To pin it, set a literal in [C].
  DECLARE default_project_id STRING;
  -- Export the object-level dependency table as well. Set FALSE if the combined
  -- report only uses the column usage x impact table; keep it in step with 15's
  -- include_object_dependency or 15 will look for files that were never written.
  DECLARE include_object_dependency BOOL DEFAULT TRUE;

  -- --------------------------------------------------------------------------
  -- [C] DERIVED / INTERNAL -- from [A]; DO NOT edit
  -- --------------------------------------------------------------------------
  -- The repository project takes default_project_id (auto-detected below); pin it
  -- to a literal only if the repository lives in a separate project.
  DECLARE repository_project_id STRING DEFAULT NULL;
  -- Token extracted from the project id (see project_token_pattern).
  DECLARE project_token STRING;
  -- The region this job runs in, which is also the path segment the files land under
  -- and the value 15 reports as source_region.
  DECLARE source_region STRING;
  DECLARE usage_impact_fqn STRING;
  DECLARE object_dependency_fqn STRING;
  DECLARE rendered_sql STRING;

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
  SET source_region = LOWER(@@location);
  -- Project-token substitution in the name inputs (before names are used).
  SET project_token =
    COALESCE(REGEXP_EXTRACT(default_project_id, project_token_pattern), '');
  SET repository_dataset =
    REPLACE(repository_dataset, '{project_token}', project_token);
  SET table_name_prefix =
    REPLACE(table_name_prefix, '{project_token}', project_token);
  SET table_name_suffix =
    REPLACE(table_name_suffix, '{project_token}', project_token);
  SET export_uri_prefix =
    REPLACE(export_uri_prefix, '{project_token}', project_token);

  -- Guards: surface a misconfigured name or URI here, not halfway through an export.
  ASSERT REGEXP_CONTAINS(repository_dataset, r'^[A-Za-z0-9_]+$')
    AS 'repository_dataset must be letters/digits/underscore only (check for an unsubstituted {project_token}).';
  ASSERT REGEXP_CONTAINS(export_uri_prefix, r'^gs://[A-Za-z0-9._-]+(/[A-Za-z0-9._-]+)*$')
    AS 'export_uri_prefix must be gs://bucket[/path] with no trailing slash and no unsubstituted {project_token}.';
  ASSERT REGEXP_CONTAINS(source_region, r'^[a-z0-9-]+$')
    AS 'Unexpected @@location; the region becomes a Cloud Storage path segment.';

  SET usage_impact_fqn = FORMAT(
    '%s.%s.%s',
    repository_project_id,
    repository_dataset,
    table_name_prefix || 'lnge_' || 't_' || 'column_usage_impact' || table_name_suffix
  );
  SET object_dependency_fqn = FORMAT(
    '%s.%s.%s',
    repository_project_id,
    repository_dataset,
    table_name_prefix || 'lnge_' || 't_' || 'object_dependency' || table_name_suffix
  );

  -- --------------------------------------------------------------------------
  -- Export 1: the column usage x impact table (the Looker Studio data source).
  --
  -- Built through EXECUTE IMMEDIATE because EXPORT DATA takes its OPTIONS as
  -- constants -- the URI cannot be a script variable -- and every name here is
  -- assembled from [A].
  -- --------------------------------------------------------------------------
  SELECT '===== EXPORT 1: column usage x impact =====' AS processing_step;

  SET rendered_sql = FORMAT(
    """
    EXPORT DATA OPTIONS (
      uri = '%s/%s/column_usage_impact/*.parquet',
      format = 'PARQUET',
      compression = 'SNAPPY',
      overwrite = TRUE
    ) AS
    SELECT * FROM `%s`
    """,
    export_uri_prefix, source_region, usage_impact_fqn
  );
  EXECUTE IMMEDIATE rendered_sql;

  -- --------------------------------------------------------------------------
  -- Export 2: the object-level dependency table.
  -- --------------------------------------------------------------------------
  IF include_object_dependency THEN
    SELECT '===== EXPORT 2: object dependency =====' AS processing_step;

    SET rendered_sql = FORMAT(
      """
      EXPORT DATA OPTIONS (
        uri = '%s/%s/object_dependency/*.parquet',
        format = 'PARQUET',
        compression = 'SNAPPY',
        overwrite = TRUE
      ) AS
      SELECT * FROM `%s`
      """,
      export_uri_prefix, source_region, object_dependency_fqn
    );
    EXECUTE IMMEDIATE rendered_sql;
  END IF;

  -- --------------------------------------------------------------------------
  -- Summary: what was written, and the updated_at that 15 will check against.
  -- A single distinct updated_at per table is what proves the export is one
  -- consistent snapshot rather than a mix of runs.
  -- --------------------------------------------------------------------------
  SET rendered_sql = FORMAT(
    """
    SELECT
      'EXPORT_REPORT_TABLES' AS step_name,
      'COMPLETED' AS status,
      @region AS source_region,
      @uri_prefix AS export_uri_prefix,
      (SELECT COUNT(*) FROM `%s`) AS column_usage_impact_rows,
      (SELECT MAX(updated_at) FROM `%s`) AS column_usage_impact_updated_at,
      (SELECT COUNT(DISTINCT updated_at) FROM `%s`) AS column_usage_impact_distinct_updated_at
    """,
    usage_impact_fqn, usage_impact_fqn, usage_impact_fqn
  );
  EXECUTE IMMEDIATE rendered_sql
  USING source_region AS region, export_uri_prefix AS uri_prefix;

EXCEPTION WHEN ERROR THEN
  SELECT
    'EXPORT_REPORT_TABLES' AS step_name,
    'FAILED' AS status,
    @@error.message AS error_message,
    'Run 03 in this region first so the static report tables exist, and check that export_uri_prefix points at a bucket this project may write to. A cross-region export must also be permitted: probe it with EXPORT DATA ... AS SELECT 1.' AS hint;
  RAISE USING MESSAGE = @@error.message;
END;
