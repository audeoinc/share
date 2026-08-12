SELECT
  COUNT(*)                                                           AS n_objects,
  MAX(BYTE_LENGTH(definition_text))                                 AS max_sql_bytes,
  APPROX_QUANTILES(BYTE_LENGTH(definition_text), 100)[OFFSET(50)]   AS p50_bytes,
  APPROX_QUANTILES(BYTE_LENGTH(definition_text), 100)[OFFSET(95)]   AS p95_bytes,
  SUM(BYTE_LENGTH(definition_text))                                 AS total_sql_bytes
FROM `project_id.lineage_repository.m_lineage_definition_registry`
WHERE is_active AND is_changed AND definition_text IS NOT NULL
  AND object_type IN ('VIEW','TABLE');
