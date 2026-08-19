-- =====================================================================
-- suffix 違い View のロジック グループ比較を事前生成してテーブルに持つ
--
-- ※ このファイルは build_table.mjs が生成する。直接編集しないこと。
--    suffix 規則や解析オプションは suffix_config.json を直して再生成する。
--    再生成: node looker_studio/view_groups/build_table.mjs
--
-- Looker Studio の操作のたびに UDF を回すのは重い（DDL をトークン化 →
-- α 等価判定 → パラメータ化 → 差分 → HTML 生成）。INFORMATION_SCHEMA の中身は
-- View をデプロイしたときしか変わらないので、スケジュールドクエリで作り置きする。
--
-- パーティションに日付を積むので、履歴が残る。
-- 「いつグループ構成が変わったか」を後から追える＝ロジック逸脱の検知に使える。
--
-- 前提: view_group_html.sql で VIEW_GROUP_INFO / VIEW_GROUP_CSS を作成済み。
-- 環境に合わせるのはセクション 0 の DECLARE だけ。本文の書き換えは要らない。
--
-- suffix の出どころ: INFORMATION_SCHEMA.SCHEMATA（データセット名）
--   _([A-Za-z]{4})$ に一致したデータセット名の末尾を suffix として使う。
--   対象 View も同じ条件で選ぶので、suffix と対象がズレない。
--   つまりデータセットが増えても SQL の修正は要らない。
-- =====================================================================


-- ---------------------------------------------------------------------
-- 0. 設定（書き換えるのはここだけ）
--
--    BigQuery は識別子（プロジェクト・データセット・関数名）をクエリ
--    パラメータにできない。@param が使えるのは値だけ。
--    そこで識別子はスクリプト変数からテキスト置換し（本文の @@PROJECT@@ など）、
--    値は EXECUTE IMMEDIATE の USING で渡す（@dataset_filter など）。
--
--    スケジュールドクエリには セクション 0 と 2 を登録する
--    （1 と 3 は初回だけ実行すればよい）。
-- ---------------------------------------------------------------------
DECLARE project_id   STRING DEFAULT 'my-project';
DECLARE udf_dataset  STRING DEFAULT 'ops_meta';    -- VIEW_GROUP_INFO / VIEW_GROUP_CSS の置き場所
DECLARE work_dataset STRING DEFAULT 'ops_meta';    -- view_logic_diff の置き場所
DECLARE region       STRING DEFAULT 'asia-northeast1';   -- 読むリージョン
DECLARE tz           STRING DEFAULT 'Asia/Tokyo';  -- snapshot_date の基準

-- 比較対象のデータセット。
-- 既定は「リージョン内で suffix の条件（_([A-Za-z]{4})$）に一致するもの全部」。
-- 対象 View も suffix 一覧も同じ条件から引くので、両者がズレない。
DECLARE dataset_filter  STRING        DEFAULT '';  -- 追加の絞り込み正規表現。'' なら絞らない（テスト用）
DECLARE source_datasets ARRAY<STRING> DEFAULT [];  -- 空でなければこの一覧だけを対象にする
DECLARE suffix_override ARRAY<STRING> DEFAULT [];  -- 空でなければ suffix はこれを使う（サンプル環境用）

DECLARE n_datasets INT64;
DECLARE n_views    INT64;

-- @@…@@ を実際の値に置き換える。EXECUTE IMMEDIATE のたびに通す。
CREATE TEMP FUNCTION fill(
  sql STRING, project STRING, udf_ds STRING, work_ds STRING,
  reg STRING, zone STRING
) AS (
  REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(sql,
    '@@PROJECT@@', project),
    '@@UDF@@',     udf_ds),
    '@@WORK@@',    work_ds),
    '@@REGION@@',  reg),
    '@@TZ@@',      zone)
);

-- 事前チェック。0 件のまま進むと空のテーブルができ、設定の間違いに気づけない。
EXECUTE IMMEDIATE fill(r"""
SELECT
  (SELECT COUNT(*)
   FROM `@@PROJECT@@.region-@@REGION@@.INFORMATION_SCHEMA.SCHEMATA`
   WHERE REGEXP_CONTAINS(schema_name, r'_([A-Za-z]{4})$')
     AND (@dataset_filter = '' OR REGEXP_CONTAINS(schema_name, @dataset_filter))),
  (SELECT COUNT(*)
   FROM `@@PROJECT@@.region-@@REGION@@.INFORMATION_SCHEMA.VIEWS`
   WHERE IF(ARRAY_LENGTH(@source_datasets) > 0,
       table_schema IN UNNEST(@source_datasets),
       REGEXP_CONTAINS(table_schema, r'_([A-Za-z]{4})$')
         AND (@dataset_filter = '' OR REGEXP_CONTAINS(table_schema, @dataset_filter))))
""", project_id, udf_dataset, work_dataset, region, tz)
INTO n_datasets, n_views
USING dataset_filter AS dataset_filter, source_datasets AS source_datasets;

IF n_views = 0 THEN
  RAISE USING MESSAGE = '対象の View が 0 件です。region / dataset_filter / source_datasets を確認してください。';
END IF;
IF n_datasets = 0 AND ARRAY_LENGTH(suffix_override) = 0 THEN
  RAISE USING MESSAGE = 'suffix を持つデータセットが 0 件です。region / dataset_filter を確認してください。';
END IF;


-- ---------------------------------------------------------------------
-- 1. 格納先（初回のみ）
-- ---------------------------------------------------------------------
EXECUTE IMMEDIATE fill(r"""
CREATE TABLE IF NOT EXISTS `@@PROJECT@@.@@WORK@@.view_logic_diff`
(
  snapshot_date   DATE           OPTIONS (description = '生成日'),
  base            STRING         OPTIONS (description = 'suffix を除いた View 名。Looker のキー。suffix を認識できなかった View は View 名そのもの'),
  view_count      INT64          OPTIONS (description = 'この base に属する View 数'),
  group_count     INT64          OPTIONS (description = 'ロジックのグループ数。1 なら全部同一'),
  has_multiple    BOOL           OPTIONS (description = 'group_count > 1。ロジック逸脱の検知用'),
  group_labels    ARRAY<STRING>  OPTIONS (description = 'ペイン見出し（同一ロジックの suffix 列記）'),
  group_sizes     ARRAY<INT64>   OPTIONS (description = '各グループの View 数'),
  suffixes        ARRAY<STRING>  OPTIONS (description = '認識した suffix 一覧'),
  unmatched_count INT64          OPTIONS (description = 'suffix を認識できなかった View 数。1 ならこの行が単独表示の View'),
  diff_html       STRING         OPTIONS (description = '比較 HTML。Templated Record に渡す')
)
PARTITION BY snapshot_date
CLUSTER BY base
OPTIONS (
  description = 'suffix 違い View のロジック グループ比較（事前生成）',
  partition_expiration_days = 400
)
""", project_id, udf_dataset, work_dataset, region, tz);


-- ---------------------------------------------------------------------
-- 2. 生成（スケジュールドクエリに登録する本体）
--
--    同じ日に何度実行しても結果が同じになるよう、当日分を消してから入れる。
--    MERGE より DELETE + INSERT のほうが単純で、パーティション単位なので安い。
-- ---------------------------------------------------------------------
EXECUTE IMMEDIATE fill(r"""
DELETE FROM `@@PROJECT@@.@@WORK@@.view_logic_diff`
WHERE snapshot_date = CURRENT_DATE('@@TZ@@')
""", project_id, udf_dataset, work_dataset, region, tz);

EXECUTE IMMEDIATE fill(r"""
INSERT INTO `@@PROJECT@@.@@WORK@@.view_logic_diff`
WITH
-- suffix 一覧。対象 View と同じ条件でデータセット名から拾う。
-- suffix_override を渡したときだけそちらを使う（サンプル環境用）。
suffixes AS (
  SELECT suffix FROM UNNEST(
    IF(ARRAY_LENGTH(@suffix_override) > 0,
       @suffix_override,
       ARRAY(
         SELECT DISTINCT REGEXP_EXTRACT(schema_name, r'_([A-Za-z]{4})$')
         FROM `@@PROJECT@@.region-@@REGION@@.INFORMATION_SCHEMA.SCHEMATA`
         WHERE REGEXP_CONTAINS(schema_name, r'_([A-Za-z]{4})$')
           AND (@dataset_filter = '' OR REGEXP_CONTAINS(schema_name, @dataset_filter))
       ))
  ) AS suffix
),
-- UDF に渡す設定。suffixList だけ実行時に決まる。
opts AS (
  SELECT CONCAT(
    '{"suffixList":',
    TO_JSON_STRING(ARRAY(SELECT suffix FROM suffixes ORDER BY suffix)),
    -- ↓ suffix_config.json から生成
    ',"literalGroups":[],"mode":"class"',
    '}'
  ) AS options_json
),

-- 対象 View。リージョン単位の INFORMATION_SCHEMA を使うので、
-- データセットごとの UNION ALL は要らない。
--
-- TABLES.ddl ではなく VIEWS.view_definition を使う。
-- TABLES.ddl は BigQuery が組み立てた CREATE VIEW 文で、OPTIONS に
-- description や作成タイムスタンプが自動で入る。View ごとに値が違うので、
-- そのまま比較すると全部が別グループに割れる。
-- view_definition はクエリ本体だけなので、ヘッダも OPTIONS も付いてこない。
-- View 自身の名前も入らないため、パラメータには参照先の差だけが残る。
src AS (
  SELECT table_name AS view_name, view_definition AS ddl
  FROM `@@PROJECT@@.region-@@REGION@@.INFORMATION_SCHEMA.VIEWS`
  WHERE IF(ARRAY_LENGTH(@source_datasets) > 0,
       table_schema IN UNNEST(@source_datasets),
       REGEXP_CONTAINS(table_schema, r'_([A-Za-z]{4})$')
         AND (@dataset_filter = '' OR REGEXP_CONTAINS(table_schema, @dataset_filter)))
),
keyed AS (
  -- suffix 一覧との ENDS_WITH で base を切る。
  -- 複数一致したら長いほうを採る（短い suffix が長い suffix の末尾に含まれる場合の対策）。
  -- LEFT JOIN なので suffix の付かない View も 1 行残る。
  SELECT
    src.view_name,
    src.ddl,
    -- suffix を認識できない View は自分の名前を base にする。
    -- 束ねる相手がいないので 1 View / 1 グループとして単独で表示される。
    COALESCE(
      SUBSTR(src.view_name, 1, LENGTH(src.view_name) - LENGTH(s.suffix) - 1),
      src.view_name
    ) AS base
  FROM src
  LEFT JOIN suffixes AS s
    ON ENDS_WITH(src.view_name, '_' || s.suffix)
  QUALIFY ROW_NUMBER() OVER (
    PARTITION BY src.view_name ORDER BY LENGTH(s.suffix) DESC
  ) = 1
)
SELECT
  CURRENT_DATE('@@TZ@@')              AS snapshot_date,
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
    `@@PROJECT@@.@@UDF@@.VIEW_GROUP_INFO`(
      ARRAY_AGG(STRUCT(view_name, ddl) ORDER BY view_name),
      -- suffixes CTE から組み立てた設定（全行で同じ値）
      (SELECT options_json FROM opts)
    ) AS info
  FROM keyed
  GROUP BY base
)
""", project_id, udf_dataset, work_dataset, region, tz)
USING dataset_filter AS dataset_filter,
      source_datasets AS source_datasets,
      suffix_override AS suffix_override;


-- ---------------------------------------------------------------------
-- 3. Looker Studio が読むビュー（最新スナップショットだけ・初回のみ）
-- ---------------------------------------------------------------------
EXECUTE IMMEDIATE fill(r"""
CREATE OR REPLACE VIEW `@@PROJECT@@.@@WORK@@.v_view_logic_diff_latest` AS
SELECT *
FROM `@@PROJECT@@.@@WORK@@.view_logic_diff`
WHERE snapshot_date = (
  SELECT MAX(snapshot_date) FROM `@@PROJECT@@.@@WORK@@.view_logic_diff`
)
""", project_id, udf_dataset, work_dataset, region, tz);


-- ---------------------------------------------------------------------
-- 4. テンプレートに貼る CSS（1 回取れば十分。template_style.html と同じ）
--
--    ここから下のコメントは単体で実行するクエリ。
--    @@PROJECT@@ / @@UDF@@ / @@WORK@@ / @@REGION@@ は実際の値に置き換えること
--    （EXECUTE IMMEDIATE を通らないので自動では置換されない）。
-- ---------------------------------------------------------------------
-- SELECT `@@PROJECT@@.@@UDF@@.VIEW_GROUP_CSS`('''{"literalGroups":[],"mode":"class"}''');


-- ---------------------------------------------------------------------
-- 5. 確認と使い方
-- ---------------------------------------------------------------------
-- 中身の確認
-- SELECT base, view_count, group_count, group_labels, unmatched_count,
--        LENGTH(diff_html) AS html_len
-- FROM `@@PROJECT@@.@@WORK@@.v_view_logic_diff_latest`
-- ORDER BY base;

-- 対象データセットと suffix（セクション 0 と同じ条件）
-- 0 件なら region か dataset_filter を疑う。
-- SELECT
--   REGEXP_EXTRACT(schema_name, r'_([A-Za-z]{4})$') AS suffix,
--   COUNT(*) AS dataset_count,
--   STRING_AGG(schema_name, ', ' ORDER BY schema_name) AS datasets
-- FROM `@@PROJECT@@.region-@@REGION@@.INFORMATION_SCHEMA.SCHEMATA`
-- WHERE REGEXP_CONTAINS(schema_name, r'_([A-Za-z]{4})$')
-- GROUP BY suffix
-- ORDER BY suffix;

-- 対象になる View の数をデータセット別に見る
-- SELECT table_schema, COUNT(*) AS view_count
-- FROM `@@PROJECT@@.region-@@REGION@@.INFORMATION_SCHEMA.VIEWS`
-- WHERE REGEXP_CONTAINS(table_schema, r'_([A-Za-z]{4})$')
-- GROUP BY table_schema
-- ORDER BY table_schema;

-- 拾えなかったデータセット（対象のつもりのものが落ちていないか）
-- SELECT schema_name
-- FROM `@@PROJECT@@.region-@@REGION@@.INFORMATION_SCHEMA.SCHEMATA`
-- WHERE NOT REGEXP_CONTAINS(schema_name, r'_([A-Za-z]{4})$')
-- ORDER BY schema_name;

-- 生成後: UDF が実際に認識した suffix（テーブルに入っている値）
-- SELECT s AS suffix, COUNT(DISTINCT base) AS base_count
-- FROM `@@PROJECT@@.@@WORK@@.v_view_logic_diff_latest`, UNNEST(suffixes) AS s
-- GROUP BY s
-- ORDER BY s;

-- suffix を認識できなかった View（単独で 1 行ずつ並ぶ）
-- SELECT base, group_labels
-- FROM `@@PROJECT@@.@@WORK@@.v_view_logic_diff_latest`
-- WHERE unmatched_count > 0
-- ORDER BY base;

-- ロジックが割れている base だけ見る（＝要確認のもの）
-- SELECT base, group_count, group_labels
-- FROM `@@PROJECT@@.@@WORK@@.v_view_logic_diff_latest`
-- WHERE has_multiple
-- ORDER BY group_count DESC, base;

-- グループ構成が変わった日を探す（ロジック逸脱がいつ入ったか）
-- SELECT base, snapshot_date, group_count, group_labels
-- FROM (
--   SELECT *,
--     LAG(TO_JSON_STRING(group_labels)) OVER w AS prev_labels,
--     TO_JSON_STRING(group_labels)      AS curr_labels
--   FROM `@@PROJECT@@.@@WORK@@.view_logic_diff`
--   WINDOW w AS (PARTITION BY base ORDER BY snapshot_date)
-- )
-- WHERE prev_labels IS NOT NULL AND prev_labels != curr_labels
-- ORDER BY snapshot_date DESC, base;
