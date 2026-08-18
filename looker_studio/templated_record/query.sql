-- =====================================================================
-- Templated Record に渡すデータ
--
-- Templated Record は「1 行のデータを HTML で表現する」チャートなので、
-- 1 行 1 カラム（HTML 文字列）を返せばよい。
--
-- 前提:
--   ・ddl_diff_html.sql で `PROJECT.DATASET.DIFF_HTML` を作成済み
--   ・(key, ddl) の 2 列を持つ `PROJECT.DATASET.v_ddl_by_key` がある
--     （作り方は ../ddl_diff.sql のセクション 0-2）
-- =====================================================================


-- ---------------------------------------------------------------------
-- A. レポート上で key を 2 つ選ぶ（Looker Studio のカスタムクエリ）
--
--   1. データを追加 → BigQuery → カスタムクエリ
--   2. 下の SELECT を貼る
--   3. 「パラメータ」で before_key / after_key を STRING として追加し、
--      「レポート編集者と閲覧者が値を変更できるようにする」を有効にする
--   4. レポートにパラメータ用のコントロールを 2 つ置く
--   5. Templated Record を配置し、表示対象のカラムに diff_html を指定する
--
--   VIEW ではなくカスタムクエリにするのは、VIEW に @パラメータを書けないため。
--   UDF は永続関数なのでカスタムクエリからも呼べる。
-- ---------------------------------------------------------------------
SELECT
  @before_key AS before_key,
  @after_key  AS after_key,
  `PROJECT.DATASET.DIFF_HTML`(
    (SELECT ddl FROM `PROJECT.DATASET.v_ddl_by_key` WHERE key = @before_key LIMIT 1),
    (SELECT ddl FROM `PROJECT.DATASET.v_ddl_by_key` WHERE key = @after_key  LIMIT 1),
    @before_key,
    @after_key,
    -- HTML が大きすぎる場合は contextLines を入れて変更箇所だけにする
    -- '{"contextLines": 3}'
    NULL
  ) AS diff_html;


-- ---------------------------------------------------------------------
-- B. 比較軸が固定なら VIEW でよい（例: 同じ View の連続する 2 スナップショット）
--
--   パラメータのリスト候補を保守しなくて済むので、運用は こちら のほうが楽。
--   Templated Record 側では view_name をフィルタして 1 行に絞る。
-- ---------------------------------------------------------------------
-- CREATE OR REPLACE VIEW `PROJECT.DATASET.v_ddl_diff_html_latest` AS
-- WITH snap AS (
--   SELECT
--     FORMAT('%s.%s', table_schema, table_name) AS view_name,
--     snapshot_date,
--     ddl,
--     LAG(ddl)           OVER w AS prev_ddl,
--     LAG(snapshot_date) OVER w AS prev_date
--   FROM `PROJECT.DATASET.view_ddl_snapshot`
--   WINDOW w AS (PARTITION BY table_schema, table_name ORDER BY snapshot_date)
-- ),
-- latest AS (
--   SELECT * EXCEPT (rn) FROM (
--     SELECT *, ROW_NUMBER() OVER (PARTITION BY view_name ORDER BY snapshot_date DESC) AS rn
--     FROM snap
--   ) WHERE rn = 1
-- )
-- SELECT
--   view_name,
--   prev_date,
--   snapshot_date,
--   prev_ddl IS DISTINCT FROM ddl AS has_change,
--   `PROJECT.DATASET.DIFF_HTML`(
--     prev_ddl, ddl,
--     CAST(prev_date     AS STRING),
--     CAST(snapshot_date AS STRING),
--     '{"contextLines": 3}'
--   ) AS diff_html
-- FROM latest
-- WHERE prev_ddl IS NOT NULL;
--
-- 実運用では UDF を毎回走らせないよう、スケジュールドクエリでテーブル化する:
-- CREATE OR REPLACE TABLE `PROJECT.DATASET.ddl_diff_html` AS
-- SELECT * FROM `PROJECT.DATASET.v_ddl_diff_html_latest`;
