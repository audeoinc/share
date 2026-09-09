-- ============================================================================
-- 09_top_slot_consumers_of_day.sql
-- ある1日のスロット消費 上位10件（正規化していない SQL 原文で確認する）
-- ============================================================================
-- 「その日いちばんスロットを食った処理はどれか」「それはどのスクリプトの一部か」を
-- 1つの結果で返す。日付を1日に絞った調査なので、正規化ではなく原文の SQL を見る。
--
-- 前提: pipeline/01〜03 を実行済みであること。
--       PROJECT / DATASET を自分の環境に合わせて書き換える。
--
-- 読み方:
--   parent_job_id が NULL          … 単独で実行されたクエリ
--   parent_job_id が入っている     … スクリプトの中の 1 文。
--                                    parent_query_head でどのスクリプトかが分かる。
--   statement_index / root_statement_count
--                                  … そのスクリプトの何文目か / 全部で何文か
--   parent_slot_hours              … スクリプト全体のスロット消費（root_slot_hours）。
--                                    この行の slot_hours（statement_slot_hours）と
--                                    比べれば、そのスクリプトの中でこの 1 文が
--                                    どれだけ支配的かが分かる。両者を足さないこと。
--
-- 注意:
--   * 時刻は UTC。creation_date も UTC 基準の日付。
--   * 親は「対象日の前後1日」まで広げて引いている。23時台に始まったスクリプトの子が
--     翌日付になることがあり、対象日だけに絞ると親を取り逃すため。
--   * slot_hours はスロット時間であって経過時間ではない。
-- ============================================================================
SET @@location = 'asia-northeast1';

BEGIN
  DECLARE target_date DATE DEFAULT DATE_SUB(CURRENT_DATE(), INTERVAL 1 DAY);
  DECLARE top_n INT64 DEFAULT 10;

  WITH resolved AS (
    SELECT *
    FROM `audeodb.bq_cost_repository.bqc_vw_t_job_cost_resolved`
    -- 親を取り逃さないよう前後1日ぶん広く読む（対象日の絞り込みは下で行う）。
    WHERE creation_date BETWEEN DATE_SUB(target_date, INTERVAL 1 DAY)
                            AND DATE_ADD(target_date, INTERVAL 1 DAY)
  ),
  parents AS (
    SELECT
      job_region,
      project_id,
      job_id,
      root_slot_hours AS parent_slot_hours,
      root_tib_billed AS parent_tib_billed,
      root_statement_count,
      SUBSTR(REGEXP_REPLACE(query, r'\s+', ' '), 1, 300) AS parent_query_head
    FROM resolved
    WHERE job_role = 'PARENT'
  )
  SELECT
    c.statement_slot_hours AS slot_hours,
    c.statement_tib_billed AS tib_billed,
    c.executor_id,
    c.executor_source,
    c.user_email,
    c.statement_type,
    c.job_id,
    -- スクリプトの一部なら、その所属と位置
    c.parent_job_id,
    c.statement_index,
    p.root_statement_count,
    p.parent_slot_hours,
    SAFE_DIVIDE(c.statement_slot_hours, p.parent_slot_hours) AS share_of_parent,
    p.parent_query_head,
    -- 原文の SQL。1日を切り出した調査なので正規化しない。
    c.query,
    c.creation_time,
    c.elapsed_ms
  FROM resolved AS c
  LEFT JOIN parents AS p
    ON  p.job_region = c.job_region
    AND p.project_id = c.project_id
    AND p.job_id     = c.root_job_id
  WHERE c.creation_date = target_date
    -- 親 SCRIPT 行は子の合計を持つ集計行なので、ランキングからは外す。
    AND c.is_cost_countable
  -- BigQuery の LIMIT は定数リテラルしか受け付けず、スクリプト変数を書くと
  -- 「LIMIT expects an INT64 literal」で落ちる。件数を変数で持ちたいので
  -- QUALIFY で絞る（こちらは通常の式なので変数を使える）。
  QUALIFY ROW_NUMBER() OVER (ORDER BY c.statement_slot_hours DESC) <= top_n
  ORDER BY c.statement_slot_hours DESC;
END;
