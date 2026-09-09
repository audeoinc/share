-- ============================================================================
-- 10_month_over_month_by_fingerprint.sql
-- 今月と先月の比較（正規化 fingerprint 単位）+ 親スクリプトの特定
-- ============================================================================
-- 「日付などが動的なだけで異なる SQL」を同一の処理として比較する。リテラルは
-- bqc_normalize_sql が ? に潰し、GA4 の events_YYYYMMDD のような日付シャードも
-- 畳み込まれるので、normalized_fingerprint が同じなら同じ処理として扱える。
--
-- 前提: pipeline/01〜03 を実行済みであること。
--       PROJECT / DATASET を自分の環境に合わせて書き換える。
--
-- 結果は 1 つの表にまとめてある:
--   row_type = 'SUMMARY'  … 追加 / 削除 / 継続 それぞれの合計と差し引き
--   row_type = 'DETAIL'   … fingerprint 単位の明細（差の絶対値が大きい順）
--
-- change_type:
--   ADDED       今月だけに現れた（先月は実行されていない）
--   REMOVED     先月だけにあった（今月は実行されていない）
--   CONTINUING  両方の月にある。slot_hours_delta が増減
--
-- 親スクリプトの列:
--   parent_fingerprint / parent_preview     どのスクリプトに属する処理か
--   parent_this_month_slot_hours            そのスクリプト全体の今月のスロット消費
--   parent_prev_month_slot_hours            同じく先月
--   ※ 親の値（root 系）は子の合計。子の値（statement 系）と足さないこと。
--     どちらか一方だけを合計すれば総量は一致する。
--
-- 注意:
--   * 集計は bqc_t_daily_cost ではなく bqc_vw_t_job_cost_resolved から行っている。
--     daily_cost には親の情報が無いため（Phase 2 で root_normalized_fingerprint を
--     daily_cost の粒度に足せば、この結合なしで同じことができるようになる）。
--     そのぶんスキャン量は多い。日常のダッシュボードではなく調査用途向け。
--   * 同じ文が複数の異なるスクリプトから呼ばれている場合、親は代表 1 件
--     （その月でいちばんスロットを食った親）を表示する。
--   * 時刻・日付はすべて UTC 基準。
--   * 保持期間（既定 180 日）を超えた月は比較できない。
-- ============================================================================
SET @@location = 'asia-northeast1';

BEGIN
  DECLARE this_month DATE DEFAULT DATE_TRUNC(CURRENT_DATE(), MONTH);
  DECLARE prev_month DATE DEFAULT DATE_SUB(DATE_TRUNC(CURRENT_DATE(), MONTH), INTERVAL 1 MONTH);
  DECLARE detail_limit INT64 DEFAULT 50;

  CREATE OR REPLACE TEMP TABLE scoped AS
  SELECT
    DATE_TRUNC(creation_date, MONTH) AS usage_month,
    job_region,
    project_id,
    job_id,
    root_job_id,
    job_role,
    is_cost_countable,
    normalized_fingerprint,
    normalized_preview,
    root_slot_hours,
    root_tib_billed,
    statement_slot_hours,
    statement_tib_billed
  FROM `audeodb.bq_cost_repository.bqc_vw_t_job_cost_resolved`
  WHERE creation_date >= prev_month
    AND creation_date < DATE_ADD(this_month, INTERVAL 1 MONTH);

  -- 親スクリプト側の月次。親行は is_cost_countable = FALSE なので別に集計する。
  CREATE OR REPLACE TEMP TABLE parent_monthly AS
  SELECT
    usage_month,
    normalized_fingerprint AS parent_fingerprint,
    ANY_VALUE(normalized_preview) AS parent_preview,
    SUM(root_slot_hours) AS parent_slot_hours
  FROM scoped
  WHERE job_role = 'PARENT'
  GROUP BY usage_month, normalized_fingerprint;

  -- 子（と単独ジョブ）を、所属する親の fingerprint 付きで月次に畳む。
  CREATE OR REPLACE TEMP TABLE child_monthly AS
  WITH parent_of_job AS (
    SELECT job_region, project_id, job_id, normalized_fingerprint AS parent_fingerprint
    FROM scoped
    WHERE job_role = 'PARENT'
  ),
  with_parent AS (
    SELECT c.*, p.parent_fingerprint
    FROM scoped AS c
    LEFT JOIN parent_of_job AS p
      ON  p.job_region = c.job_region
      AND p.project_id = c.project_id
      AND p.job_id     = c.root_job_id
    WHERE c.is_cost_countable
  )
  SELECT
    usage_month,
    normalized_fingerprint,
    ANY_VALUE(normalized_preview) AS preview,
    COUNT(*)                  AS job_count,
    SUM(statement_slot_hours) AS slot_hours,
    SUM(statement_tib_billed) AS tib_billed,
    -- 同じ文が複数のスクリプトから呼ばれている場合は、いちばん食っている親を代表にする。
    ARRAY_AGG(parent_fingerprint IGNORE NULLS ORDER BY statement_slot_hours DESC LIMIT 1)[SAFE_OFFSET(0)]
      AS parent_fingerprint
  FROM with_parent
  GROUP BY usage_month, normalized_fingerprint;

  CREATE OR REPLACE TEMP TABLE compared AS
  SELECT
    COALESCE(cur.normalized_fingerprint, prv.normalized_fingerprint) AS normalized_fingerprint,
    COALESCE(cur.preview, prv.preview) AS preview,
    COALESCE(cur.parent_fingerprint, prv.parent_fingerprint) AS parent_fingerprint,
    CASE
      WHEN prv.normalized_fingerprint IS NULL THEN 'ADDED'
      WHEN cur.normalized_fingerprint IS NULL THEN 'REMOVED'
      ELSE 'CONTINUING'
    END AS change_type,
    IFNULL(cur.slot_hours, 0) AS this_month_slot_hours,
    IFNULL(prv.slot_hours, 0) AS prev_month_slot_hours,
    IFNULL(cur.slot_hours, 0) - IFNULL(prv.slot_hours, 0) AS slot_hours_delta,
    IFNULL(cur.tib_billed, 0) - IFNULL(prv.tib_billed, 0) AS tib_billed_delta,
    IFNULL(cur.job_count, 0)  AS this_month_jobs,
    IFNULL(prv.job_count, 0)  AS prev_month_jobs
  FROM (SELECT * FROM child_monthly WHERE usage_month = this_month) AS cur
  FULL OUTER JOIN (SELECT * FROM child_monthly WHERE usage_month = prev_month) AS prv
    ON prv.normalized_fingerprint = cur.normalized_fingerprint;

  WITH summary AS (
    SELECT
      'SUMMARY' AS row_type,
      change_type,
      CAST(NULL AS STRING) AS normalized_fingerprint,
      FORMAT('%d 件の SQL', COUNT(*)) AS preview,
      CAST(NULL AS STRING) AS parent_fingerprint,
      CAST(NULL AS STRING) AS parent_preview,
      ROUND(SUM(this_month_slot_hours), 2) AS this_month_slot_hours,
      ROUND(SUM(prev_month_slot_hours), 2) AS prev_month_slot_hours,
      ROUND(SUM(slot_hours_delta), 2)      AS slot_hours_delta,
      SUM(this_month_jobs)                 AS this_month_jobs,
      SUM(prev_month_jobs)                 AS prev_month_jobs,
      CAST(NULL AS FLOAT64) AS parent_this_month_slot_hours,
      CAST(NULL AS FLOAT64) AS parent_prev_month_slot_hours
    FROM compared
    GROUP BY change_type
  ),
  detail AS (
    SELECT
      'DETAIL' AS row_type,
      c.change_type,
      c.normalized_fingerprint,
      c.preview,
      c.parent_fingerprint,
      COALESCE(pc.parent_preview, pp.parent_preview) AS parent_preview,
      ROUND(c.this_month_slot_hours, 3) AS this_month_slot_hours,
      ROUND(c.prev_month_slot_hours, 3) AS prev_month_slot_hours,
      ROUND(c.slot_hours_delta, 3)      AS slot_hours_delta,
      c.this_month_jobs,
      c.prev_month_jobs,
      ROUND(pc.parent_slot_hours, 3) AS parent_this_month_slot_hours,
      ROUND(pp.parent_slot_hours, 3) AS parent_prev_month_slot_hours
    FROM compared AS c
    LEFT JOIN parent_monthly AS pc
      ON pc.parent_fingerprint = c.parent_fingerprint AND pc.usage_month = this_month
    LEFT JOIN parent_monthly AS pp
      ON pp.parent_fingerprint = c.parent_fingerprint AND pp.usage_month = prev_month
    -- BigQuery の LIMIT は定数リテラルしか受け付けず、スクリプト変数を書くと
    -- 「LIMIT expects an INT64 literal」で落ちる。件数を変数で持ちたいので
    -- QUALIFY で絞る（こちらは通常の式なので変数を使える）。
    -- QUALIFY は WHERE / GROUP BY / HAVING のいずれかと併用する必要があるため
    -- WHERE TRUE を置いている。
    WHERE TRUE
    QUALIFY ROW_NUMBER() OVER (ORDER BY ABS(c.slot_hours_delta) DESC) <= detail_limit
  )
  SELECT * FROM summary
  UNION ALL
  SELECT * FROM detail
  -- 'DETAIL' < 'SUMMARY' なので、サマリを先頭に出すには降順にする。
  ORDER BY row_type DESC, ABS(slot_hours_delta) DESC;
END;
