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
--   View 名の切り分けも UDF に渡す一覧も、この結果から実行時に決まる。
--   つまり suffix が増えても SQL の修正は要らない。
-- =====================================================================


-- ---------------------------------------------------------------------
-- 0. 設定（書き換えるのはここだけ）
--
--    BigQuery は識別子（プロジェクト・データセット・関数名）をクエリ
--    パラメータにできない。@param が使えるのは値だけ。
--    そこでスクリプト変数に持ち、EXECUTE IMMEDIATE でテキスト置換する。
--    本文の @@PROJECT@@ などが置換される目印。
--
--    スケジュールドクエリには セクション 0 と 2 を登録する
--    （1 と 3 は初回だけ実行すればよい）。
-- ---------------------------------------------------------------------
DECLARE project_id      STRING        DEFAULT 'my-project';
DECLARE udf_dataset     STRING        DEFAULT 'ops_meta';   -- VIEW_GROUP_INFO / VIEW_GROUP_CSS の置き場所
DECLARE work_dataset    STRING        DEFAULT 'ops_meta';   -- view_logic_diff の置き場所
DECLARE source_datasets ARRAY<STRING> DEFAULT ['mart'];     -- 比較対象の View があるデータセット（複数可）
DECLARE region          STRING        DEFAULT 'asia-northeast1';  -- SCHEMATA を読むリージョン
DECLARE tz              STRING        DEFAULT 'Asia/Tokyo'; -- snapshot_date の基準

DECLARE src_sql STRING;

-- @@…@@ を実際の値に置き換える。EXECUTE IMMEDIATE のたびに通す。
-- @@SRC@@ を最後にするのは、埋め込んだ中身がさらに置換されないようにするため。
CREATE TEMP FUNCTION fill(
  sql STRING, project STRING, udf_ds STRING, work_ds STRING,
  reg STRING, zone STRING, src STRING
) AS (
  REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(sql,
    '@@PROJECT@@', project),
    '@@UDF@@',     udf_ds),
    '@@WORK@@',    work_ds),
    '@@REGION@@',  reg),
    '@@TZ@@',      zone),
    '@@SRC@@',     src)
);

-- 対象 View を集める部分を source_datasets から組み立てる。
--
-- TABLES.ddl ではなく VIEWS.view_definition を使う。
-- TABLES.ddl は BigQuery が組み立てた CREATE VIEW 文で、OPTIONS に
-- description や作成タイムスタンプが自動で入る。View ごとに値が違うので、
-- そのまま比較すると全部が別グループに割れる。
-- view_definition はクエリ本体だけなので、ヘッダも OPTIONS も付いてこない。
-- View 自身の名前も入らないため、パラメータには参照先の差だけが残る。
SET src_sql = (
  SELECT STRING_AGG(
    FORMAT(
      "SELECT table_name AS view_name, view_definition AS ddl FROM `%s.%s.INFORMATION_SCHEMA.VIEWS`",
      project_id, d),
    "\n  UNION ALL\n  ")
  FROM UNNEST(source_datasets) AS d
);
IF src_sql IS NULL THEN
  RAISE USING MESSAGE = 'source_datasets が空です。比較対象の View があるデータセットを指定してください。';
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
""", project_id, udf_dataset, work_dataset, region, tz, src_sql);


-- ---------------------------------------------------------------------
-- 2. 生成（スケジュールドクエリに登録する本体）
--
--    同じ日に何度実行しても結果が同じになるよう、当日分を消してから入れる。
--    MERGE より DELETE + INSERT のほうが単純で、パーティション単位なので安い。
-- ---------------------------------------------------------------------
EXECUTE IMMEDIATE fill(r"""
DELETE FROM `@@PROJECT@@.@@WORK@@.view_logic_diff`
WHERE snapshot_date = CURRENT_DATE('@@TZ@@')
""", project_id, udf_dataset, work_dataset, region, tz, src_sql);

EXECUTE IMMEDIATE fill(r"""
INSERT INTO `@@PROJECT@@.@@WORK@@.view_logic_diff`
WITH
-- データセット名から suffix を集める。手で一覧を持たないための CTE。
--   mart_abjp / raw_cduk → abjp / cduk
-- リージョンはセクション 0 の region から入る（データセットのロケーションと揃える）。
-- ここが 0 件だと全 View が「suffix 未認識」になり、1 本ずつ単独で並ぶだけになる。
-- 件数は下の確認クエリで見ておく。
suffixes AS (
  SELECT DISTINCT REGEXP_EXTRACT(schema_name, r'_([A-Za-z]{4})$') AS suffix
  FROM `@@PROJECT@@.region-@@REGION@@.INFORMATION_SCHEMA.SCHEMATA`
  WHERE REGEXP_CONTAINS(schema_name, r'_([A-Za-z]{4})$')
),
-- サンプル用: データセットを 1 つにまとめた環境で試すときは、上の suffixes を
-- そのまま使うと 0 件になる。その場合だけ次で置き換える。
-- suffixes AS (
--   SELECT suffix FROM UNNEST(['abjp', 'abuk', 'abus', 'cdjp', 'cduk', 'cdus', 'efjp', 'efuk', 'efus']) AS suffix
-- ),

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

src AS (
  @@SRC@@
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
""", project_id, udf_dataset, work_dataset, region, tz, src_sql);


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
""", project_id, udf_dataset, work_dataset, region, tz, src_sql);


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

-- SCHEMATA から取れた suffix 一覧（suffixes CTE が返すものと同じ）
-- 0 件なら region か schemataPattern を疑う。
-- SELECT
--   suffix,
--   COUNT(*) AS dataset_count,
--   STRING_AGG(schema_name, ', ' ORDER BY schema_name) AS datasets
-- FROM (
--   SELECT schema_name, REGEXP_EXTRACT(schema_name, r'_([A-Za-z]{4})$') AS suffix
--   FROM `@@PROJECT@@.region-@@REGION@@.INFORMATION_SCHEMA.SCHEMATA`
-- )
-- WHERE suffix IS NOT NULL
-- GROUP BY suffix
-- ORDER BY suffix;

-- 拾えなかったデータセット（suffix 付きのつもりのものが混ざっていないか）
-- SELECT schema_name
-- FROM `@@PROJECT@@.region-@@REGION@@.INFORMATION_SCHEMA.SCHEMATA`
-- WHERE NOT REGEXP_CONTAINS(schema_name, r'_([A-Za-z]{4})$')
-- ORDER BY schema_name;

-- suffix ごとに何本の View が割り当たったか。
-- 0 本の suffix は、無関係なデータセット名から拾ったもの（実害はない）。
-- 抜けている suffix があれば、そのデータセットが source_datasets に入っていない。
-- WITH suffixes AS (
--   SELECT DISTINCT REGEXP_EXTRACT(schema_name, r'_([A-Za-z]{4})$') AS suffix
--   FROM `@@PROJECT@@.region-@@REGION@@.INFORMATION_SCHEMA.SCHEMATA`
--   WHERE REGEXP_CONTAINS(schema_name, r'_([A-Za-z]{4})$')
-- ), src AS (
--   SELECT table_name AS view_name
--   FROM `@@PROJECT@@.<source_dataset>.INFORMATION_SCHEMA.VIEWS`
-- )
-- SELECT s.suffix, COUNT(src.view_name) AS view_count
-- FROM suffixes AS s
-- LEFT JOIN src ON ENDS_WITH(src.view_name, '_' || s.suffix)
-- GROUP BY s.suffix
-- ORDER BY s.suffix;

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
