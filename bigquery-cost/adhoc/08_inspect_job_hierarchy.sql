-- ============================================================================
-- 08_inspect_job_hierarchy.sql
-- 親子ジョブ（SCRIPT と その子文）の構造を実測する
-- ============================================================================
-- pipeline を「親も保持する」形へ拡張する前に、実データで確認しておくための
-- 読み取り専用クエリ。結果を見てから設計を確定する。
--
-- 使い方:
--   1) 下の PROJECT / REGION を自分の環境に合わせて書き換える
--   2) bq query --project_id=audeodb --use_legacy_sql=false < adhoc/08_inspect_job_hierarchy.sql
--      （コンソールに貼り付けてもよい。結果は1つの表にまとめてある）
--
-- 4つの確認を 1 つの結果表として返す:
--
--   check 1  ジョブの分類
--            statement_type × 子であるか × 子を持つか の組み合わせ別の件数とコスト。
--            「子を持つジョブ」は自分自身では計算していない集計行なので、コストの
--            合計から外す必要がある。SCRIPT 以外にも子を持つ種別（CALL など）が
--            居ないかをここで見る。
--
--   check 2  多段ネストの有無
--            「子であり、かつ子を持つ」ジョブの件数。0 なら親子は 1 段だけなので、
--            root_job_id = IFNULL(parent_job_id, job_id) で大元に到達できる。
--            1 件でもあれば再帰的な解決が必要になり、設計が変わる。
--
--   check 3  親と子の集計値の一致
--            親 SCRIPT 自身が持つ total_bytes_billed / total_slot_ms と、その子の
--            合計を比べる。一致するなら親は子の集計行＝両方足すと二重計上になる。
--            親側が 0 なら、そもそも二重計上は起きない。
--
--   check 4  子の本数の分布
--            statement_index（親の中での実行順）を持たせる価値があるかの判断材料。
--
-- 読み取り専用。何も作成・更新しない。
-- ============================================================================
SET @@location = 'asia-northeast1';

BEGIN
  DECLARE lookback_days INT64 DEFAULT 7;

  CREATE OR REPLACE TEMP TABLE recent_jobs AS
  SELECT
    job_id,
    parent_job_id,
    IFNULL(statement_type, '(null)')   AS statement_type,
    destination_table IS NOT NULL      AS has_destination,
    IFNULL(total_bytes_billed, 0)      AS bytes_billed,
    IFNULL(total_slot_ms, 0)           AS slot_ms
  FROM `audeodb.region-asia-northeast1`.INFORMATION_SCHEMA.JOBS_BY_PROJECT
  WHERE creation_time >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL lookback_days DAY)
    AND job_type = 'QUERY'
    AND state = 'DONE';

  -- 「子を持つか」は相関サブクエリではなく親IDの一覧との LEFT JOIN で出す
  -- （BigQuery は CTE を参照する相関サブクエリを常に de-correlate できるとは限らない）。
  CREATE OR REPLACE TEMP TABLE classified_jobs AS
  WITH parent_ids AS (
    SELECT DISTINCT parent_job_id AS job_id
    FROM recent_jobs
    WHERE parent_job_id IS NOT NULL
  )
  SELECT
    j.*,
    j.parent_job_id IS NOT NULL AS is_child,
    p.job_id IS NOT NULL        AS has_children
  FROM recent_jobs AS j
  LEFT JOIN parent_ids AS p
    ON p.job_id = j.job_id;

  WITH
  check1_classification AS (
    SELECT
      1 AS check_no,
      'ジョブの分類' AS check_name,
      FORMAT(
        'statement_type=%s / is_child=%t / has_children=%t',
        statement_type, is_child, has_children
      ) AS dimension,
      COUNT(*) AS job_count,
      ROUND(SUM(bytes_billed) / POW(1024, 4), 4) AS tib_billed,
      ROUND(SUM(slot_ms) / 3600000, 2)           AS slot_hours
    FROM classified_jobs
    GROUP BY statement_type, is_child, has_children
  ),
  check2_nesting AS (
    SELECT
      2 AS check_no,
      '多段ネストの有無' AS check_name,
      '子であり、かつ子を持つジョブ（0 なら親子は1段のみ）' AS dimension,
      COUNTIF(is_child AND has_children) AS job_count,
      ROUND(SUM(IF(is_child AND has_children, bytes_billed, 0)) / POW(1024, 4), 4) AS tib_billed,
      ROUND(SUM(IF(is_child AND has_children, slot_ms, 0)) / 3600000, 2)           AS slot_hours
    FROM classified_jobs
  ),
  script_parents AS (
    SELECT *
    FROM classified_jobs
    WHERE statement_type = 'SCRIPT'
      AND has_children
  ),
  children_of_scripts AS (
    SELECT c.*
    FROM classified_jobs AS c
    JOIN script_parents AS p
      ON p.job_id = c.parent_job_id
  ),
  check3_rollup AS (
    SELECT
      3 AS check_no,
      '親と子の集計値の一致' AS check_name,
      'A: 親 SCRIPT 自身の値' AS dimension,
      COUNT(*) AS job_count,
      ROUND(SUM(bytes_billed) / POW(1024, 4), 4) AS tib_billed,
      ROUND(SUM(slot_ms) / 3600000, 2)           AS slot_hours
    FROM script_parents

    UNION ALL

    SELECT
      3,
      '親と子の集計値の一致',
      'B: その親に属する子の合計（A と一致するなら親は集計行）',
      COUNT(*),
      ROUND(SUM(bytes_billed) / POW(1024, 4), 4),
      ROUND(SUM(slot_ms) / 3600000, 2)
    FROM children_of_scripts
  ),
  child_counts AS (
    SELECT parent_job_id, COUNT(*) AS child_count
    FROM classified_jobs
    WHERE parent_job_id IS NOT NULL
    GROUP BY parent_job_id
  ),
  check4_fanout AS (
    SELECT
      4 AS check_no,
      '子の本数の分布' AS check_name,
      FORMAT(
        '親 %d 件 / 子は最大 %d 本・中央値 %d 本',
        COUNT(*),
        MAX(child_count),
        CAST(APPROX_QUANTILES(child_count, 2)[SAFE_OFFSET(1)] AS INT64)
      ) AS dimension,
      SUM(child_count) AS job_count,
      CAST(NULL AS FLOAT64) AS tib_billed,
      CAST(NULL AS FLOAT64) AS slot_hours
    FROM child_counts
  )
  SELECT * FROM check1_classification
  UNION ALL SELECT * FROM check2_nesting
  UNION ALL SELECT * FROM check3_rollup
  UNION ALL SELECT * FROM check4_fanout
  ORDER BY check_no, job_count DESC, dimension;
END;
