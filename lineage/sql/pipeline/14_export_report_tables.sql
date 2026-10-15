-- ============================================================================
-- 14_export_report_tables.sql
-- BigQuery Physical Lineage Repository - Export the report tables for one region
-- ============================================================================
-- Half of the cross-region report. Register this as a scheduled query in EVERY
-- region EXCEPT the one that hosts the combined report; the host region needs no
-- export, because 15_build_cross_region_report.sql reads its tables locally.
--
-- Two statements, no scripting. EXPORT DATA takes its OPTIONS as constants -- the
-- URI cannot be a variable -- so there is nothing for a DECLARE to do, and a plain
-- statement is easier to read in the scheduled-query editor than a script that
-- assembles the same string.
--
-- EDIT FOUR THINGS, then register one copy per region:
--   1. the scheduled query's location (this region)
--   2. YOUR_BUCKET   -> a bucket in the HOST region, not in this one
--   3. YOUR_REGION   -> this region, e.g. us-central1. It is just a path segment,
--                       but 15 addresses it by that exact name
--   4. project_id / lineage_repository / the table names, if 01 and 03 were
--      deployed here with a different project, dataset or table prefix/suffix
-- Keep the part before YOUR_REGION identical to 15's export_uri_prefix.
--
-- THE BUCKET BELONGS TO THE HOST REGION. Exporting straight into it is what
-- removes the need to copy objects between buckets, which no SQL statement can do.
-- Confirm a cross-region export is permitted in your project before relying on it:
--   EXPORT DATA OPTIONS (uri = 'gs://<host bucket>/probe/*.parquet',
--     format = 'PARQUET', overwrite = TRUE) AS SELECT 1 AS probe;
--
-- PARQUET IS NOT OPTIONAL. lnge_t_column_usage_impact carries
-- dependency_path ARRAY<STRING> and lnge_t_object_dependency carries
-- column_dependencies ARRAY<STRUCT<...>>. CSV cannot represent either and the
-- export fails outright; Parquet carries them natively and self-describes its
-- schema, so 15 declares no schema for the external tables it reads them through.
--
-- LEFTOVER SHARDS ARE HANDLED ON THE READING SIDE. `*` in the URI shards the output
-- by size, and whether overwrite = TRUE deletes shards from a LARGER previous export
-- is not something this script can guarantee. It does not have to: every row of one
-- 03 rebuild carries the same updated_at, so 15 reads only each source's newest
-- updated_at and reports the leftovers instead of counting them. Deleting the
-- objects under this prefix before an export is therefore optional tidying, not a
-- correctness requirement.
--
-- SCHEDULING: after 03 in this region, and far enough before 15 that the export has
-- finished. 15 does not trust that timing -- it checks each source's age from the
-- data itself -- but a late export still means a late report.
-- ============================================================================
-- Scheduled queries take their location from the transfer config, not from SQL.
-- This line is for running the file by hand in the console; set it to this region.
SET @@location = 'asia-northeast1';

-- The column usage x impact table: the Looker Studio data source.
EXPORT DATA OPTIONS (
  uri = 'gs://YOUR_BUCKET/lineage/cross_region/YOUR_REGION/column_usage_impact/*.parquet',
  format = 'PARQUET',
  compression = 'SNAPPY',
  overwrite = TRUE
) AS
SELECT *
FROM `project_id.lineage_repository.lnge_t_column_usage_impact`;

-- The object-level dependency table. Drop this statement if the combined report
-- does not use it, and set include_object_dependency = FALSE in 15 to match --
-- otherwise 15 looks for files that were never written.
EXPORT DATA OPTIONS (
  uri = 'gs://YOUR_BUCKET/lineage/cross_region/YOUR_REGION/object_dependency/*.parquet',
  format = 'PARQUET',
  compression = 'SNAPPY',
  overwrite = TRUE
) AS
SELECT *
FROM `project_id.lineage_repository.lnge_t_object_dependency`;
