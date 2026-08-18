-- =====================================================================
-- suffix 違い View のロジック グループ比較を事前生成してテーブルに持つ
--
-- Looker Studio の操作のたびに UDF を回すのは重い（9 本の DDL をトークン化 →
-- α 等価判定 → パラメータ化 → 差分 → HTML 生成）。INFORMATION_SCHEMA の中身は
-- View をデプロイしたときしか変わらないので、スケジュールドクエリで作り置きする。
--
-- パーティションに日付を積むので、履歴が残る。
-- 「いつグループ構成が変わったか」を後から追える＝ロジック逸脱の検知に使える。
--
-- 前提: view_group_html.sql で VIEW_GROUP_INFO / VIEW_GROUP_CSS を作成済み。
-- PROJECT / DATASET は自分の環境に置換すること。
-- =====================================================================


-- ---------------------------------------------------------------------
-- 1. 格納先（初回のみ）
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `PROJECT.DATASET.view_logic_diff`
(
  snapshot_date   DATE           OPTIONS (description = '生成日'),
  base            STRING         OPTIONS (description = 'suffix を除いた View 名。Looker のキー'),
  view_count      INT64          OPTIONS (description = 'この base に属する View 数'),
  group_count     INT64          OPTIONS (description = 'ロジックのグループ数。1 なら全部同一'),
  has_multiple    BOOL           OPTIONS (description = 'group_count > 1。ロジック逸脱の検知用'),
  group_labels    ARRAY<STRING>  OPTIONS (description = 'ペイン見出し（同一ロジックの suffix 列記）'),
  group_sizes     ARRAY<INT64>   OPTIONS (description = '各グループの View 数'),
  suffixes        ARRAY<STRING>  OPTIONS (description = '認識した suffix 一覧'),
  unmatched_count INT64          OPTIONS (description = 'suffix を認識できなかった View 数'),
  diff_html       STRING         OPTIONS (description = '比較 HTML。Templated Record に渡す')
)
PARTITION BY snapshot_date
CLUSTER BY base
OPTIONS (
  description = 'suffix 違い View のロジック グループ比較（事前生成）',
  -- 履歴を無期限に持ちたくなければ有効化する
  partition_expiration_days = 400
);


-- ---------------------------------------------------------------------
-- 2. 生成（スケジュールドクエリに登録する本体）
--
--    同じ日に何度実行しても結果が同じになるよう、当日分を消してから入れる。
--    MERGE より DELETE + INSERT のほうが単純で、パーティション単位なので安い。
-- ---------------------------------------------------------------------
DELETE FROM `PROJECT.DATASET.view_logic_diff`
WHERE snapshot_date = CURRENT_DATE('Asia/Tokyo');

INSERT INTO `PROJECT.DATASET.view_logic_diff`
WITH
-- ↓↓↓ 対象の View を集める。データセットが複数あるなら UNION ALL で足す ↓↓↓
--
-- TABLES.ddl ではなく VIEWS.view_definition を使う。
-- TABLES.ddl は BigQuery が組み立てた CREATE VIEW 文で、OPTIONS に
-- description や作成タイムスタンプが自動で入る。View ごとに値が違うので、
-- そのまま比較すると全部が別グループに割れる。
-- view_definition はクエリ本体だけなので、ヘッダも OPTIONS も付いてこない。
-- View 自身の名前も入らないため、パラメータには参照先の差だけが残る。
--
-- （UDF 側でも OPTIONS は既定で落とすので、TABLES.ddl のままでも動く。
--   その場合は下のコメントアウトを使う。）
src AS (
  SELECT table_name AS view_name, view_definition AS ddl
  FROM `PROJECT.TARGET_DATASET.INFORMATION_SCHEMA.VIEWS`
),
-- TABLES.ddl を使う場合:
-- src AS (
--   SELECT table_name AS view_name, ddl
--   FROM `PROJECT.TARGET_DATASET.INFORMATION_SCHEMA.TABLES`
--   WHERE table_type = 'VIEW'
-- ),
-- ↑↑↑ ここまで ↑↑↑
keyed AS (
  SELECT
    view_name,
    ddl,
    -- suffix 規則は UDF の options_json と必ず揃えること。
    -- ここでズレると base の束ね方と UDF の解析が食い違う。
    REGEXP_EXTRACT(view_name, r'^(.*)_(?:ab|cd|ef)(?:jp|us|uk)$') AS base
  FROM src
)
SELECT
  CURRENT_DATE('Asia/Tokyo')          AS snapshot_date,
  base,
  CAST(info.view_count      AS INT64) AS view_count,
  CAST(info.group_count     AS INT64) AS group_count,
  info.group_count > 1                AS has_multiple,
  info.group_labels,
  ARRAY(SELECT CAST(x AS INT64) FROM UNNEST(info.group_sizes) AS x) AS group_sizes,
  info.suffixes,
  CAST(info.unmatched_count AS INT64) AS unmatched_count,
  info.html                           AS diff_html
FROM (
  SELECT
    base,
    `PROJECT.DATASET.VIEW_GROUP_INFO`(
      ARRAY_AGG(STRUCT(view_name, ddl) ORDER BY view_name),
      -- mode='class' なら CSS は Templated Record のテンプレートに置く。
      -- テンプレートを触りたくないなら 'embed'。
      '''{
        "suffixParts": [["ab","cd","ef"],["jp","us","uk"]],
        "mode": "class"
      }'''
    ) AS info
  FROM keyed
  WHERE base IS NOT NULL
  GROUP BY base
);


-- ---------------------------------------------------------------------
-- 3. Looker Studio が読むビュー（最新スナップショットだけ）
--
--    Looker からはこれを参照する。base をプルダウンにして diff_html を
--    Templated Record に渡すだけ。パラメータもカスタムクエリも UDF も不要。
-- ---------------------------------------------------------------------
CREATE OR REPLACE VIEW `PROJECT.DATASET.v_view_logic_diff_latest` AS
SELECT *
FROM `PROJECT.DATASET.view_logic_diff`
WHERE snapshot_date = (
  SELECT MAX(snapshot_date) FROM `PROJECT.DATASET.view_logic_diff`
);


-- ---------------------------------------------------------------------
-- 4. テンプレートに貼る CSS（mode='class' のとき。1 回取れば十分）
-- ---------------------------------------------------------------------
-- SELECT `PROJECT.DATASET.VIEW_GROUP_CSS`(
--   '{"suffixParts": [["ab","cd","ef"],["jp","us","uk"]]}'
-- );


-- ---------------------------------------------------------------------
-- 5. 使い方の例
-- ---------------------------------------------------------------------
-- ロジックが割れている base だけ見る（＝要確認のもの）
-- SELECT base, group_count, group_labels
-- FROM `PROJECT.DATASET.v_view_logic_diff_latest`
-- WHERE has_multiple
-- ORDER BY group_count DESC, base;

-- グループ構成が変わった日を探す（ロジック逸脱がいつ入ったか）
-- SELECT base, snapshot_date, group_count, group_labels
-- FROM (
--   SELECT *,
--     LAG(TO_JSON_STRING(group_labels)) OVER w AS prev_labels,
--     TO_JSON_STRING(group_labels)      AS curr_labels
--   FROM `PROJECT.DATASET.view_logic_diff`
--   WINDOW w AS (PARTITION BY base ORDER BY snapshot_date)
-- )
-- WHERE prev_labels IS NOT NULL AND prev_labels != curr_labels
-- ORDER BY snapshot_date DESC, base;
