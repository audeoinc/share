-- =====================================================================
-- suffix 違い View のロジック グループ比較を事前生成してテーブルに持つ
--
-- ※ このファイルを直接編集する。生成物ではない。
--    設定はセクション 0 の DECLARE だけ。ほかに設定を置く場所はない。
--
-- Looker Studio の操作のたびに UDF を回すのは重い（DDL をトークン化 →
-- α 等価判定 → パラメータ化 → 差分 → HTML 生成）。INFORMATION_SCHEMA の中身は
-- View をデプロイしたときしか変わらないので、スケジュールドクエリで作り置きする。
--
-- パーティションに日付を積むので、履歴が残る。
-- 「いつグループ構成が変わったか」を後から追える＝ロジック逸脱の検知に使える。
--
-- 前提: view_group_html.sql で UDF を作成済み。
--       udf_prefix / udf_suffix / 関数の基本名は両ファイルで一致させること。
-- =====================================================================


-- ---------------------------------------------------------------------
-- 0. 設定（書き換えるのはここだけ）
--
--    SET @@location は DECLARE より前に置く。本文の参照はすべて
--    EXECUTE IMMEDIATE の中にあり、ロケーションを推測できるテーブル参照が
--    無いため、指定しないと既定のロケーションで実行される。
--    下の region と同じ値にすること。
--
--    識別子（プロジェクト・データセット・正規表現）は本文の @@…@@ を
--    置き換えて渡す。BigQuery は識別子をクエリ パラメータにできないため。
--    配列や JSON は値なので USING のパラメータで渡す。
--
--    スケジュールドクエリには セクション 0 と 2 を登録する
--    （1 と 3 は初回だけ、5 は確認用なので不要）。
-- ---------------------------------------------------------------------
SET @@location = 'asia-northeast1';

-- 置き場所
DECLARE project_id   STRING DEFAULT 'my-project';
DECLARE udf_dataset  STRING DEFAULT 'ops_meta';   -- UDF の置き場所
DECLARE work_dataset STRING DEFAULT 'ops_meta';   -- テーブル / ビューの置き場所
DECLARE region       STRING DEFAULT 'asia-northeast1';  -- 読むリージョン（上の @@location と揃える）
DECLARE tz           STRING DEFAULT 'Asia/Tokyo'; -- snapshot_date の基準
DECLARE partition_expiration_days INT64 DEFAULT 400;  -- 履歴の保持日数

-- 作るオブジェクトの名前。命名規則に沿って組み立てる。
--   テーブル: object_prefix + <kind>_ + object_base_name + object_suffix
--   ビュー  : object_prefix + vw_<kind>_ + object_base_name + object_suffix
--   UDF     : udf_prefix + <関数の基本名> + udf_suffix
-- kind は 't'（transaction）か 'm'（master）。
-- このテーブルは日次のスナップショットを積むので 't'。
DECLARE object_prefix    STRING DEFAULT '';
DECLARE object_suffix    STRING DEFAULT '';
DECLARE object_kind      STRING DEFAULT 't';
DECLARE object_base_name STRING DEFAULT 'view_logic_diff';

-- UDF 側は view_group_html.sql と同じ値にすること。食い違うと関数が見つからない。
DECLARE udf_prefix   STRING DEFAULT '';
DECLARE udf_suffix   STRING DEFAULT '';
DECLARE info_fn_base STRING DEFAULT 'VIEW_GROUP_INFO';
DECLARE css_fn_base  STRING DEFAULT 'VIEW_GROUP_CSS';

-- 組み立てた名前（下の SET で決まる）。データセット名は含まない。
DECLARE table_name STRING;
DECLARE view_name  STRING;
DECLARE info_fn    STRING;
DECLARE css_fn     STRING;

-- 対象の絞り込み。データセットと View 名で、それぞれ include / exclude を持つ。
--   include … 空配列なら絞らない。指定すると**いずれか**に一致するものだけが対象
--   exclude … **いずれか**に一致したものを落とす。include のあとに効く
-- 正規表現は部分一致（REGEXP_CONTAINS）。完全一致にしたいなら ^…$ を付ける。
--
--   include 例: [r'^mart_']  [r'^mart_abjp$', r'^mart_abus$']
--   exclude 例: [r'_tmp$', r'_bk$', r'^wk_']
DECLARE include_dataset_patterns ARRAY<STRING> DEFAULT [r'_([A-Za-z]{4})$'];
DECLARE exclude_dataset_patterns ARRAY<STRING> DEFAULT [];

-- View 名は INFORMATION_SCHEMA.VIEWS.table_name（suffix を含んだ実際の名前）に効く。
-- base 名ではないので、ある base だけ見たいなら r'^v_daily_sales_' のように書く。
DECLARE include_view_patterns    ARRAY<STRING> DEFAULT [];
DECLARE exclude_view_patterns    ARRAY<STRING> DEFAULT [];

-- suffix の切り出し。1 つ目のキャプチャが suffix になる。
DECLARE suffix_pattern STRING DEFAULT r'_([A-Za-z]{4})$';

-- suffix 一覧。空ならデータセット名から suffix_pattern で自動抽出する。
-- View が suffix を持たないデータセットに置いてある場合など、
-- データセット名から導けないときだけ並べる。
DECLARE suffix_list ARRAY<STRING> DEFAULT [];

-- UDF に渡す解析オプション（JSON）。1 つ以上のキーを持つオブジェクトにすること。
-- 指定できるキーは view_group_html.sql の冒頭に一覧がある。
--   suffixAware / literalSuffixWords / literalGroups / includeUnmatched /
--   stripOptions / substitutable / layout / mode / 表示の調整
-- suffixList は下の suffixes から自動で入るので、ここには書かない。
DECLARE analyze_options STRING DEFAULT '{"literalGroups":[],"mode":"class"}';

DECLARE schema_cond    STRING;  -- dataset の include/exclude から組み立てる（SCHEMATA 用）
DECLARE view_cond      STRING;  -- 同上（VIEWS 用。列名が違うので別に作る）
DECLARE view_name_cond STRING;  -- view の include/exclude から組み立てる
DECLARE n_datasets  INT64;
DECLARE n_views     INT64;

IF object_kind NOT IN ('t', 'm') THEN
  RAISE USING MESSAGE = "object_kind は 't'（transaction）か 'm'（master）にしてください。";
END IF;
IF object_base_name = '' OR info_fn_base = '' OR css_fn_base = '' THEN
  RAISE USING MESSAGE = 'object_base_name / info_fn_base / css_fn_base は空にできません。';
END IF;

-- 命名規則どおりに組み立てる。ビューは最新スナップショットだけを返すが、
-- テーブルと同じ base 名で vw_ が付く形にそろえてある。
SET table_name = CONCAT(object_prefix, object_kind, '_', object_base_name, object_suffix);
SET view_name  = CONCAT(object_prefix, 'vw_', object_kind, '_', object_base_name, object_suffix);
SET info_fn    = CONCAT(udf_prefix, info_fn_base, udf_suffix);
SET css_fn     = CONCAT(udf_prefix, css_fn_base, udf_suffix);

IF NOT REGEXP_CONTAINS(TRIM(analyze_options), r'^\{\s*"') THEN
  RAISE USING MESSAGE = 'analyze_options は 1 つ以上のキーを持つ JSON オブジェクトにしてください（例: {"mode":"class"}）。';
END IF;

-- include / exclude を条件文に組み立てる。3 本とも形は同じで、見る列が違うだけ。
--   データセット名は SCHEMATA では schema_name、VIEWS では table_schema。
--   View 名は VIEWS の table_name。
SET schema_cond = CONCAT(
  IF(ARRAY_LENGTH(include_dataset_patterns) = 0, 'TRUE',
    (SELECT CONCAT('(', STRING_AGG(FORMAT("REGEXP_CONTAINS(schema_name, r'%s')", p), ' OR '), ')')
     FROM UNNEST(include_dataset_patterns) AS p)),
  IF(ARRAY_LENGTH(exclude_dataset_patterns) = 0, '',
    (SELECT CONCAT(' AND NOT (', STRING_AGG(FORMAT("REGEXP_CONTAINS(schema_name, r'%s')", p), ' OR '), ')')
     FROM UNNEST(exclude_dataset_patterns) AS p)));

SET view_cond = CONCAT(
  IF(ARRAY_LENGTH(include_dataset_patterns) = 0, 'TRUE',
    (SELECT CONCAT('(', STRING_AGG(FORMAT("REGEXP_CONTAINS(table_schema, r'%s')", p), ' OR '), ')')
     FROM UNNEST(include_dataset_patterns) AS p)),
  IF(ARRAY_LENGTH(exclude_dataset_patterns) = 0, '',
    (SELECT CONCAT(' AND NOT (', STRING_AGG(FORMAT("REGEXP_CONTAINS(table_schema, r'%s')", p), ' OR '), ')')
     FROM UNNEST(exclude_dataset_patterns) AS p)));

SET view_name_cond = CONCAT(
  IF(ARRAY_LENGTH(include_view_patterns) = 0, 'TRUE',
    (SELECT CONCAT('(', STRING_AGG(FORMAT("REGEXP_CONTAINS(table_name, r'%s')", p), ' OR '), ')')
     FROM UNNEST(include_view_patterns) AS p)),
  IF(ARRAY_LENGTH(exclude_view_patterns) = 0, '',
    (SELECT CONCAT(' AND NOT (', STRING_AGG(FORMAT("REGEXP_CONTAINS(table_name, r'%s')", p), ' OR '), ')')
     FROM UNNEST(exclude_view_patterns) AS p)));

-- 事前チェック。0 件のまま進むと空のテーブルができ、設定の間違いに気づけない。
EXECUTE IMMEDIATE REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(r"""
SELECT
  (SELECT COUNT(*)
   FROM `@@PROJECT@@.region-@@REGION@@.INFORMATION_SCHEMA.SCHEMATA`
   WHERE REGEXP_CONTAINS(schema_name, r'@@SUFFIX_PATTERN@@') AND (@@SCHEMA_COND@@)),
  (SELECT COUNT(*)
   FROM `@@PROJECT@@.region-@@REGION@@.INFORMATION_SCHEMA.VIEWS`
   WHERE (@@VIEW_COND@@) AND (@@VIEW_NAME_COND@@))
""",
  '@@PROJECT@@',        project_id),
  '@@REGION@@',         region),
  '@@SUFFIX_PATTERN@@', suffix_pattern),
  '@@SCHEMA_COND@@',    schema_cond),
  '@@VIEW_COND@@',      view_cond),
  '@@VIEW_NAME_COND@@', view_name_cond)
INTO n_datasets, n_views;

IF n_views = 0 THEN
  RAISE USING MESSAGE = '対象の View が 0 件です。region / include_dataset_patterns / include_view_patterns を確認してください。';
END IF;
IF n_datasets = 0 AND ARRAY_LENGTH(suffix_list) = 0 THEN
  RAISE USING MESSAGE = 'suffix を持つデータセットが 0 件です。suffix_pattern / include_dataset_patterns を確認するか、suffix_list に直接並べてください。';
END IF;


-- ---------------------------------------------------------------------
-- 1. 格納先（初回とスキーマを変えたときだけ）
--
--    CREATE OR REPLACE なので、実行すると既存の行はすべて消える。
--    パーティションに積んだ履歴（いつグループ構成が変わったか）も一緒に消える。
--    スケジュールドクエリに登録するのはセクション 0 と 2 だけなので、
--    日次の生成でここが動くことはない。
-- ---------------------------------------------------------------------
EXECUTE IMMEDIATE REPLACE(REPLACE(REPLACE(REPLACE(r"""
CREATE OR REPLACE TABLE `@@PROJECT@@.@@WORK@@.@@TABLE@@`
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
  partition_expiration_days = @@RETENTION@@
)
""",
  '@@PROJECT@@',   project_id),
  '@@WORK@@',      work_dataset),
  '@@RETENTION@@', CAST(partition_expiration_days AS STRING)),
  '@@TABLE@@',     table_name);


-- ---------------------------------------------------------------------
-- 2. 生成（スケジュールドクエリに登録する本体）
--
--    同じ日に何度実行しても結果が同じになるよう、当日分を消してから入れる。
--    MERGE より DELETE + INSERT のほうが単純で、パーティション単位なので安い。
-- ---------------------------------------------------------------------
EXECUTE IMMEDIATE REPLACE(REPLACE(REPLACE(REPLACE(r"""
DELETE FROM `@@PROJECT@@.@@WORK@@.@@TABLE@@`
WHERE snapshot_date = CURRENT_DATE('@@TZ@@')
""",
  '@@PROJECT@@', project_id),
  '@@WORK@@',    work_dataset),
  '@@TZ@@',      tz),
  '@@TABLE@@',   table_name);

EXECUTE IMMEDIATE REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(r"""
INSERT INTO `@@PROJECT@@.@@WORK@@.@@TABLE@@`
WITH
-- suffix 一覧。suffix_list が空なら、対象データセットの名前から切り出す。
suffixes AS (
  SELECT suffix FROM UNNEST(
    IF(ARRAY_LENGTH(@suffix_list) > 0,
       @suffix_list,
       ARRAY(
         SELECT DISTINCT REGEXP_EXTRACT(schema_name, r'@@SUFFIX_PATTERN@@')
         FROM `@@PROJECT@@.region-@@REGION@@.INFORMATION_SCHEMA.SCHEMATA`
         WHERE REGEXP_CONTAINS(schema_name, r'@@SUFFIX_PATTERN@@')
           AND (@@SCHEMA_COND@@)
       ))
  ) AS suffix
),
-- UDF に渡す設定。suffixList だけ実行時に決まるので、analyze_options に足す。
opts AS (
  SELECT CONCAT(
    '{"suffixList":',
    TO_JSON_STRING(ARRAY(SELECT suffix FROM suffixes ORDER BY suffix)),
    ',',
    SUBSTR(TRIM(@analyze_options), 2)
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
  WHERE (@@VIEW_COND@@) AND (@@VIEW_NAME_COND@@)
),
keyed AS (
  -- suffix 一覧との ENDS_WITH で base を切る。区切りは '_' 固定
  -- （UDF 側の抽出も '_' 前提なので、片方だけ変えると食い違う）。
  -- 複数一致したら長いほうを採る。
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
    `@@PROJECT@@.@@UDF@@.@@INFO_FN@@`(
      ARRAY_AGG(STRUCT(view_name, ddl) ORDER BY view_name),
      -- suffixes から組み立てた設定（全行で同じ値）
      (SELECT options_json FROM opts)
    ) AS info
  FROM keyed
  GROUP BY base
)
""",
  '@@PROJECT@@',        project_id),
  '@@UDF@@',            udf_dataset),
  '@@WORK@@',           work_dataset),
  '@@REGION@@',         region),
  '@@TZ@@',             tz),
  '@@TABLE@@',          table_name),
  '@@INFO_FN@@',        info_fn),
  '@@SUFFIX_PATTERN@@', suffix_pattern),
  '@@SCHEMA_COND@@',    schema_cond),
  '@@VIEW_COND@@',      view_cond),
  '@@VIEW_NAME_COND@@', view_name_cond)
USING suffix_list AS suffix_list, analyze_options AS analyze_options;


-- ---------------------------------------------------------------------
-- 3. Looker Studio が読むビュー（最新スナップショットだけ・初回のみ）
--    名前は object_prefix + vw_<kind>_ + object_base_name + object_suffix。
-- ---------------------------------------------------------------------
EXECUTE IMMEDIATE REPLACE(REPLACE(REPLACE(REPLACE(r"""
CREATE OR REPLACE VIEW `@@PROJECT@@.@@WORK@@.@@VIEW@@` AS
SELECT *
FROM `@@PROJECT@@.@@WORK@@.@@TABLE@@`
WHERE snapshot_date = (
  SELECT MAX(snapshot_date) FROM `@@PROJECT@@.@@WORK@@.@@TABLE@@`
)
""",
  '@@PROJECT@@', project_id),
  '@@WORK@@',    work_dataset),
  '@@TABLE@@',   table_name),
  '@@VIEW@@',    view_name);


-- ---------------------------------------------------------------------
-- 4. テンプレートに貼る CSS（1 回取れば十分。template_style.html と同じ）
--
--    これだけはコメントのまま。毎回 8 KB の CSS を返しても邪魔なので、
--    必要なときに @@PROJECT@@ / @@UDF@@ を置き換えて実行する。
-- ---------------------------------------------------------------------
-- SELECT `@@PROJECT@@.@@UDF@@.@@CSS_FN@@`(@analyze_options);


-- ---------------------------------------------------------------------
-- 5. 確認（ここから下は実行される）
--
--    それぞれ 1 文ずつ結果が出る。BigQuery の結果タブは番号しか出ないので、
--    どのクエリの結果かが分かるよう先頭に check_name を付けてある。上から順に
--      5-1 生成結果の中身
--      5-2 ロジックが割れている base（＝要確認）
--      5-3 suffix を認識できなかった View
--      5-4 対象データセットと suffix
--      5-5 データセット別の対象 View 数
--      5-5b View 名の条件で落ちた View
--      5-6 条件から外れたデータセット
--      5-7 グループ構成が変わった日
-- ---------------------------------------------------------------------

-- 5-1 生成結果の中身
EXECUTE IMMEDIATE REPLACE(REPLACE(REPLACE(r"""
SELECT
  '5-1 生成結果の中身'                AS check_name,
  base                              AS base_view_name,
  view_count                        AS views_in_base,
  group_count                       AS logic_group_count,
  group_labels                      AS logic_groups_by_suffix,
  unmatched_count                   AS suffix_unrecognized_views,
  LENGTH(diff_html)                 AS diff_html_length_chars
FROM `@@PROJECT@@.@@WORK@@.@@VIEW@@`
ORDER BY base_view_name
""",
  '@@PROJECT@@', project_id),
  '@@WORK@@',    work_dataset),
  '@@VIEW@@',    view_name);

-- 5-2 ロジックが割れている base（＝要確認のもの）
EXECUTE IMMEDIATE REPLACE(REPLACE(REPLACE(r"""
SELECT
  '5-2 ロジックが割れている base'      AS check_name,
  base                              AS base_view_name,
  view_count                        AS views_in_base,
  group_count                       AS logic_group_count,
  group_labels                      AS logic_groups_by_suffix
FROM `@@PROJECT@@.@@WORK@@.@@VIEW@@`
WHERE has_multiple
ORDER BY logic_group_count DESC, base_view_name
""",
  '@@PROJECT@@', project_id),
  '@@WORK@@',    work_dataset),
  '@@VIEW@@',    view_name);

-- 5-3 suffix を認識できなかった View（単独で 1 行ずつ並ぶ）
EXECUTE IMMEDIATE REPLACE(REPLACE(REPLACE(r"""
SELECT
  '5-3 suffix を認識できなかった View' AS check_name,
  base                              AS unrecognized_view_name,
  LENGTH(diff_html)                 AS diff_html_length_chars
FROM `@@PROJECT@@.@@WORK@@.@@VIEW@@`
WHERE unmatched_count > 0
ORDER BY unrecognized_view_name
""",
  '@@PROJECT@@', project_id),
  '@@WORK@@',    work_dataset),
  '@@VIEW@@',    view_name);

-- 5-4 対象データセットと suffix（セクション 0 と同じ条件）
EXECUTE IMMEDIATE REPLACE(REPLACE(REPLACE(REPLACE(r"""
SELECT
  '5-4 対象データセットと suffix'      AS check_name,
  REGEXP_EXTRACT(schema_name, r'@@SUFFIX_PATTERN@@')  AS extracted_suffix,
  COUNT(*)                                            AS dataset_count,
  STRING_AGG(schema_name, ', ' ORDER BY schema_name)  AS dataset_names
FROM `@@PROJECT@@.region-@@REGION@@.INFORMATION_SCHEMA.SCHEMATA`
WHERE REGEXP_CONTAINS(schema_name, r'@@SUFFIX_PATTERN@@') AND (@@SCHEMA_COND@@)
GROUP BY check_name, extracted_suffix
ORDER BY extracted_suffix
""",
  '@@PROJECT@@',        project_id),
  '@@REGION@@',         region),
  '@@SUFFIX_PATTERN@@', suffix_pattern),
  '@@SCHEMA_COND@@',    schema_cond);

-- 5-5 データセット別の対象 View 数
EXECUTE IMMEDIATE REPLACE(REPLACE(REPLACE(REPLACE(r"""
SELECT
  '5-5 データセット別の対象 View 数'   AS check_name,
  table_schema                      AS dataset_name,
  COUNT(*)                          AS target_view_count
FROM `@@PROJECT@@.region-@@REGION@@.INFORMATION_SCHEMA.VIEWS`
WHERE (@@VIEW_COND@@) AND (@@VIEW_NAME_COND@@)
GROUP BY check_name, dataset_name
ORDER BY dataset_name
""",
  '@@PROJECT@@',        project_id),
  '@@REGION@@',         region),
  '@@VIEW_COND@@',      view_cond),
  '@@VIEW_NAME_COND@@', view_name_cond);

-- 5-5b View 名の条件で落ちた View（対象のつもりのものが落ちていないか）
--      include_view_patterns / exclude_view_patterns が空なら 0 件。
EXECUTE IMMEDIATE REPLACE(REPLACE(REPLACE(REPLACE(r"""
SELECT
  '5-5b View 名の条件で落ちた View'    AS check_name,
  table_schema                      AS dataset_name,
  table_name                        AS excluded_view_name
FROM `@@PROJECT@@.region-@@REGION@@.INFORMATION_SCHEMA.VIEWS`
WHERE (@@VIEW_COND@@) AND NOT (@@VIEW_NAME_COND@@)
ORDER BY dataset_name, excluded_view_name
""",
  '@@PROJECT@@',        project_id),
  '@@REGION@@',         region),
  '@@VIEW_COND@@',      view_cond),
  '@@VIEW_NAME_COND@@', view_name_cond);

-- 5-6 条件から外れたデータセット（対象のつもりのものが落ちていないか）
EXECUTE IMMEDIATE REPLACE(REPLACE(REPLACE(r"""
SELECT
  '5-6 条件から外れたデータセット'     AS check_name,
  schema_name                       AS excluded_dataset_name
FROM `@@PROJECT@@.region-@@REGION@@.INFORMATION_SCHEMA.SCHEMATA`
WHERE NOT (@@SCHEMA_COND@@)
ORDER BY excluded_dataset_name
""",
  '@@PROJECT@@',     project_id),
  '@@REGION@@',      region),
  '@@SCHEMA_COND@@', schema_cond);

-- 5-7 グループ構成が変わった日（ロジック逸脱がいつ入ったか）
--     履歴が 1 日分しかなければ 0 件。
EXECUTE IMMEDIATE REPLACE(REPLACE(REPLACE(r"""
SELECT
  '5-7 グループ構成が変わった日'       AS check_name,
  base                              AS base_view_name,
  snapshot_date                     AS changed_on,
  group_count                       AS logic_group_count_after,
  prev_labels                       AS logic_groups_before_json,
  curr_labels                       AS logic_groups_after_json
FROM (
  SELECT *,
    LAG(TO_JSON_STRING(group_labels)) OVER w AS prev_labels,
    TO_JSON_STRING(group_labels)      AS curr_labels
  FROM `@@PROJECT@@.@@WORK@@.@@TABLE@@`
  WINDOW w AS (PARTITION BY base ORDER BY snapshot_date)
)
WHERE prev_labels IS NOT NULL AND prev_labels != curr_labels
ORDER BY changed_on DESC, base_view_name
""",
  '@@PROJECT@@', project_id),
  '@@WORK@@',    work_dataset),
  '@@TABLE@@',   table_name);
