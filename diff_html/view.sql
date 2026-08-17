SELECT
  SPLIT(v, '/')[SAFE_OFFSET(1)] AS project,
  SPLIT(v, '/')[SAFE_OFFSET(3)] AS dataset,
  SPLIT(v, '/')[SAFE_OFFSET(5)] AS view_name,
  MAX(timestamp)  AS last_accessed_at,
  COUNT(*)        AS query_count,
  COUNT(DISTINCT protopayload_auditlog.authenticationInfo.principalEmail) AS distinct_users
FROM `project.audit_dataset.cloudaudit_googleapis_com_data_access`,
  UNNEST(JSON_VALUE_ARRAY(
    protopayload_auditlog.metadataJson,
    '$.jobChange.job.jobStats.queryStats.referencedViews'
  )) AS v
WHERE timestamp >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 180 DAY)
GROUP BY project, dataset, view_name
ORDER BY last_accessed_at DESC;
