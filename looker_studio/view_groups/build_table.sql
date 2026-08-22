-- =====================================================================
-- suffix 違い View のロジック グループ比較を事前生成してテーブルに持つ
--
-- ※ このファイルを直接編集する。生成物ではない。
--    設定は CONFIGURATION の DECLARE だけ。ほかに設定を置く場所はない。
--
-- Looker Studio の操作のたびに UDF を回すのは重い（DDL をトークン化 →
-- α 等価判定 → パラメータ化 → 差分 → HTML 生成）。INFORMATION_SCHEMA の中身は
-- View をデプロイしたときしか変わらないので、スケジュールドクエリで作り置きする。
--
-- パーティションに日付を積むので、履歴が残る。
-- 「いつグループ構成が変わったか」を後から追える＝ロジック逸脱の検知に使える。
--
-- 前提: view_group_html.sql で 4 つの UDF を作成済み。
--       udf_dataset / udf_name_prefix / udf_name_suffix は両ファイルで
--       一致させること。食い違うと関数が見つからない。
--
-- 命名と設定の書き方、動的 SQL の組み立ては lineage プロジェクト
-- （lineage/sql/pipeline/03_run_daily_lineage_pipeline.sql）にそろえてある。
--
-- 動的 SQL の書き方（4 手）:
--   1. SET sql_template          … __…__ を含む SQL を置く
--   2. EXECUTE IMMEDIATE render_call_sql INTO rendered_sql USING sql_template
--   3. ASSERT で未展開のプレースホルダが残っていないことを確かめる
--   4. EXECUTE IMMEDIATE rendered_sql [INTO …] [USING …]
--
-- プレースホルダ（展開は viewlgc_render_dynamic_sql が行う）:
--   __TARGET_PROJECT__     読み取り対象のプロジェクト
--   __JOB_REGION__         region- を除いたロケーション
--   __T_DIFF_HIST__        履歴テーブル（project.dataset.table）
--   __V_DIFF__             最新スナップショットのビュー（同上）
--   __UDF_ANALYZE__        analyze 関数（project.dataset.function）
--   __UDF_RENDER__         render 関数（同上）
--   __UDF_CSS__            group_css 関数（同上）
--   __TZ__                 snapshot_date の基準タイムゾーン
--   __RETENTION_DAYS__     パーティションの保持日数
--   __SUFFIX_PATTERN__     suffix を切り出す正規表現
--   __SCHEMA_COND__        SCHEMATA 用の絞り込み条件（SQL 片）
--   __VIEW_DATASET_COND__  VIEWS 用のデータセット条件（SQL 片）
--   __VIEW_NAME_COND__     VIEWS 用の View 名条件（SQL 片）
--
-- 識別子（プロジェクト・データセット・テーブル・関数名・正規表現）は
-- クエリ パラメータにできないのでこの目印で渡す。配列や JSON は値なので
-- USING のパラメータで渡す。
--
-- スケジュールドクエリには CONFIGURATION と セクション 2 を登録する
-- （1 と 3 は初回だけ、5 は確認用なので不要）。
-- =====================================================================
SET @@location = 'asia-northeast1';

BEGIN
-- ---------------------------------------------------------------------
-- CONFIGURATION（書き換えるのはここだけ）
--
--   [A] 環境ごとに必ず見るもの
--   [B] 既定のままで動くもの
--   [C] 導出・内部用。編集しない
--
--   リージョンは先頭の SET @@location が唯一の置き場所。job_region は
--   そこから受け取る。SET @@location は DECLARE より前に置く。
-- ---------------------------------------------------------------------
-- [A] 環境ごとに必ず見るもの ------------------------------------------
-- プロジェクト ID は実行時に自動検出する（[C]）。別プロジェクトを見る
-- ときだけ [C] の *_project_id にリテラルを入れて固定する。
--
-- プロジェクト トークンの置換
DECLARE project_token_pattern STRING DEFAULT r'^([^-]+)';
-- データセット（作る先 / UDF）
DECLARE work_dataset STRING DEFAULT 'ops_meta';
DECLARE udf_dataset  STRING DEFAULT 'ops_meta';
-- テーブル・ビューの命名（prefix / suffix）
DECLARE table_name_prefix STRING DEFAULT '';
DECLARE table_name_suffix STRING DEFAULT '';
-- UDF の命名（prefix / suffix）
DECLARE udf_name_prefix STRING DEFAULT '';
DECLARE udf_name_suffix STRING DEFAULT '';
-- 解析対象のデータセット（どのデータセットの View を集めるか）
DECLARE analysis_include_dataset_patterns ARRAY<STRING> DEFAULT [r'_([A-Za-z]{4})$'];
DECLARE analysis_exclude_dataset_patterns ARRAY<STRING> DEFAULT [];
-- 解析対象の View 名（どの View を集めるか）
DECLARE analysis_include_object_patterns ARRAY<STRING> DEFAULT [];
DECLARE analysis_exclude_object_patterns ARRAY<STRING> DEFAULT [];
--
-- 変数の説明:
--   project_token_pattern
--     自動検出したプロジェクト ID からこの正規表現で切り出したトークン
--     （REGEXP_EXTRACT。キャプチャがあればグループ 1）が、下のデータセット名と
--     prefix / suffix に書いた '{project_token}' をすべて置き換える。例:
--     プロジェクト 'mycompany-prod-123' に r'-([^-]+)-' なら 'prod' になるので、
--     table_name_prefix='{project_token}_' が 'prod_' になる。既定は最初の
--     ハイフン区切り。一致しなければ '' になり、残った '{project_token}' は
--     下の ASSERT で落ちる。view_group_html.sql と合わせること。
--   work_dataset / udf_dataset
--     テーブルとビューを作るデータセット / UDF が置いてあるデータセット。
--     udf_dataset は view_group_html.sql と同じ値にすること。
--   table_name_prefix / table_name_suffix
--     テーブル・ビューの命名。物理名は下の SET で
--       prefix + 'viewlgc_' + 区分 + 基本名 + suffix
--     と組み立てる。'viewlgc_' はこのシステムの識別子、区分は 'm_'（master）/
--     't_'（transaction）でどちらもリテラル。環境ごとに変わるのは prefix と
--     suffix だけなので、変数はこの 2 つ。区切りの '_' は値に含めて書く。
--     例: prefix='ope_' / suffix='_tky' で ope_viewlgc_t_diff_hist_tky。
--     使える文字は英数字と '_' と '-'（参照はすべてバッククォート引用なので
--     '-tky' のようなハイフンも安全）。データセット名と UDF 名は '-' 不可。
--   udf_name_prefix / udf_name_suffix
--     UDF の命名。関数名は [C] で
--       udf_prefix + 'viewlgc_' + 基本名 + udf_suffix
--     と組み立て、view_group_html.sql が作った名前と一致させる必要がある。
--     ルーチン名は英数字と '_' しか使えない（'-' 不可）ので、テーブル側の
--     prefix / suffix とは別に持つ。ハイフンは下の ASSERT で落ちる。
--   analysis_include_dataset_patterns / analysis_exclude_dataset_patterns
--   analysis_include_object_patterns  / analysis_exclude_object_patterns
--     対象の絞り込み。4 つとも形は同じ。
--       include … 空配列なら絞らない。指定すると**いずれか**に一致するものだけ
--       exclude … **いずれか**に一致したものを落とす。include のあとに効く
--     正規表現は部分一致（REGEXP_CONTAINS）。完全一致にしたいなら ^…$ を付ける。
--     View 名は INFORMATION_SCHEMA.VIEWS.table_name（suffix を含んだ実際の名前）
--     に効く。base 名ではないので、ある base だけ見たいなら
--     r'^v_daily_sales_' のように書く。
--       include 例: [r'^mart_']  [r'^mart_abjp$', r'^mart_abus$']
--       exclude 例: [r'_tmp$', r'_bk$', r'^wk_']

-- [B] 既定のままで動くもの --------------------------------------------
-- snapshot_date の基準タイムゾーン。
DECLARE snapshot_time_zone STRING DEFAULT 'Asia/Tokyo';
-- 履歴の保持日数（パーティションの有効期限）。
DECLARE partition_expiration_days INT64 DEFAULT 400;
-- suffix の切り出し。1 つ目のキャプチャが suffix になる。
-- analysis_include_dataset_patterns が「どのデータセットを見るか」なのに対し、
-- こちらは「同じ意味を持つ文字列をどう取り出すか」。役割が違う。
DECLARE suffix_pattern STRING DEFAULT r'_([A-Za-z]{4})$';
-- suffix 一覧。空ならデータセット名から suffix_pattern で自動抽出する。
-- View が suffix を持たないデータセットに置いてある場合など、
-- データセット名から導けないときだけ並べる。
DECLARE suffix_list ARRAY<STRING> DEFAULT [];
-- UDF に渡す解析オプション（JSON）。1 つ以上のキーを持つオブジェクトにすること。
-- 指定できるキーは view_group_html.sql の冒頭に一覧がある。
--   equivalentLiterals / suffixAware / includeUnmatched /
--   stripOptions / substitutable / layout / mode / 表示の調整
-- equivalentLiterals は「同じグループとみなす文字列の組」の一覧。
--   ["suffix", ["aa","bb"], ["cc","dd"]]
-- "suffix" は予約語で、その View 自身の suffix とその区分を表す。
-- 明示の組は View に関係なく効く。既定は ["suffix"]（従来と同じ挙動）。
-- suffixList は下の suffixes から自動で入るので、ここには書かない。
-- 綴りを間違えたキーは UDF 側で黙って無視される。
DECLARE analyze_options STRING DEFAULT '{"equivalentLiterals":["suffix"],"mode":"class"}';

-- [C] 導出・内部用。編集しない ----------------------------------------
-- リージョンは @@location が唯一の置き場所。
DECLARE job_region STRING DEFAULT @@location;
-- プロジェクトは自動検出した値を使う。役割ごとに別プロジェクトにするときだけ
-- DEFAULT にリテラルを入れて固定する（COALESCE で非 NULL が勝つ）。
DECLARE default_project_id STRING;
DECLARE work_project_id    STRING DEFAULT NULL;  -- テーブル・ビューの置き場所
DECLARE udf_project_id     STRING DEFAULT NULL;  -- UDF の置き場所
DECLARE target_project_id  STRING DEFAULT NULL;  -- 読み取り対象
DECLARE project_token      STRING;

-- 作るオブジェクトの物理名（下の SET で組み立てる）。データセット名は含まない。
-- オブジェクトが増えたらここに 1 行足し、SET と本文の __…__ を対で増やし、
-- viewlgc_render_dynamic_sql にも置換を 1 段足す。
DECLARE table_diff_hist STRING;  -- 日次スナップショットを積むテーブル
DECLARE view_diff       STRING;  -- 最新スナップショットだけのビュー

-- view_group_html.sql が作った関数名。同じ規則で組み立てて突き合わせる。
-- 解析と描画が別の UDF なのは、インラインのコード ブロブが 1 個あたり 32 KB
-- までのため。JS UDF から別の UDF は呼べないので、つなぐのはこの SQL の仕事。
DECLARE udf_analyze_function_name STRING;
DECLARE udf_render_function_name  STRING;
DECLARE udf_css_function_name     STRING;
DECLARE udf_sql_function_name     STRING;

-- 動的 SQL。render_call_sql は 1 度だけ組み立てて全テンプレートで使い回す。
-- 呼び出しごとに変わるのは @sql_template だけ。
DECLARE render_call_sql STRING;
DECLARE sql_template    STRING;
DECLARE rendered_sql    STRING;

-- include / exclude から組み立てる条件文。見る列が違うので 3 本作る。
DECLARE schema_condition       STRING;  -- SCHEMATA.schema_name
DECLARE view_dataset_condition STRING;  -- VIEWS.table_schema
DECLARE view_name_condition    STRING;  -- VIEWS.table_name
DECLARE target_dataset_count INT64;
DECLARE target_view_count    INT64;


-- 実行中のプロジェクトを INFORMATION_SCHEMA.SCHEMATA から自動検出する
-- （catalog_name = ジョブが動いているプロジェクト）。リージョン修飾の
-- 識別子はパラメータにできないので @@location から組み立てる。
EXECUTE IMMEDIATE FORMAT(
  "SELECT DISTINCT catalog_name FROM `region-%s`.INFORMATION_SCHEMA.SCHEMATA LIMIT 1",
  @@location
) INTO default_project_id;
ASSERT default_project_id IS NOT NULL AS
  'プロジェクト ID を自動検出できません（このリージョンにデータセットが無い？）。work_project_id などにリテラルを入れて固定してください。';
SET work_project_id   = COALESCE(work_project_id,   default_project_id);
SET udf_project_id    = COALESCE(udf_project_id,    default_project_id);
SET target_project_id = COALESCE(target_project_id, default_project_id);

-- 名前を組み立てる前に '{project_token}' を置き換える。
SET project_token =
  COALESCE(REGEXP_EXTRACT(default_project_id, project_token_pattern), '');
SET work_dataset      = REPLACE(work_dataset,      '{project_token}', project_token);
SET udf_dataset       = REPLACE(udf_dataset,       '{project_token}', project_token);
SET table_name_prefix = REPLACE(table_name_prefix, '{project_token}', project_token);
SET table_name_suffix = REPLACE(table_name_suffix, '{project_token}', project_token);
SET udf_name_prefix   = REPLACE(udf_name_prefix,   '{project_token}', project_token);
SET udf_name_suffix   = REPLACE(udf_name_suffix,   '{project_token}', project_token);

ASSERT REGEXP_CONTAINS(work_dataset, r'^[A-Za-z0-9_]+$') AS
  'work_dataset は英数字と _ だけにしてください（置換されていない {project_token} が残っていませんか）。';
ASSERT REGEXP_CONTAINS(udf_dataset, r'^[A-Za-z0-9_]+$') AS
  'udf_dataset は英数字と _ だけにしてください（置換されていない {project_token} が残っていませんか）。';

-- テーブル: prefix + 'viewlgc_' + 区分 + 基本名 + suffix
-- ビュー  : prefix + 'viewlgc_' + 'vw_' + 区分 + 基本名 + suffix
-- 区分 't_' は transaction（'m_' は master）。テーブルは日次スナップショットの
-- 積み上げなので基本名に _hist を付け、ビューは最新 1 日ぶんなので付けない。
SET table_diff_hist =
  table_name_prefix || 'viewlgc_' || 't_' || 'diff_hist' || table_name_suffix;
SET view_diff =
  table_name_prefix || 'viewlgc_' || 'vw_' || 't_' || 'diff' || table_name_suffix;
ASSERT REGEXP_CONTAINS(table_diff_hist, r'^[A-Za-z0-9_-]+$') AS
  'table_diff_hist の名前が不正です。';
ASSERT REGEXP_CONTAINS(view_diff, r'^[A-Za-z0-9_-]+$') AS
  'view_diff の名前が不正です。';

-- UDF: udf_prefix + 'viewlgc_' + 基本名 + udf_suffix（view_group_html.sql と同じ）
SET udf_analyze_function_name =
  udf_name_prefix || 'viewlgc_' || 'analyze' || udf_name_suffix;
SET udf_render_function_name =
  udf_name_prefix || 'viewlgc_' || 'render' || udf_name_suffix;
SET udf_css_function_name =
  udf_name_prefix || 'viewlgc_' || 'group_css' || udf_name_suffix;
SET udf_sql_function_name =
  udf_name_prefix || 'viewlgc_' || 'render_dynamic_sql' || udf_name_suffix;
ASSERT REGEXP_CONTAINS(udf_analyze_function_name, r'^[A-Za-z0-9_]+$') AS
  'udf_analyze_function_name が不正です（ルーチン名に使えるのは英数字と _ だけ。- は不可）。';
ASSERT REGEXP_CONTAINS(udf_render_function_name, r'^[A-Za-z0-9_]+$') AS
  'udf_render_function_name が不正です（ルーチン名に使えるのは英数字と _ だけ。- は不可）。';
ASSERT REGEXP_CONTAINS(udf_css_function_name, r'^[A-Za-z0-9_]+$') AS
  'udf_css_function_name が不正です（ルーチン名に使えるのは英数字と _ だけ。- は不可）。';
ASSERT REGEXP_CONTAINS(udf_sql_function_name, r'^[A-Za-z0-9_]+$') AS
  'udf_sql_function_name が不正です（ルーチン名に使えるのは英数字と _ だけ。- は不可）。';

ASSERT REGEXP_CONTAINS(TRIM(analyze_options), r'^\{\s*"') AS
  'analyze_options は 1 つ以上のキーを持つ JSON オブジェクトにしてください（例: {"mode":"class"}）。';

-- include / exclude を条件文に組み立てる。3 本とも形は同じで、見る列が違うだけ。
--   データセット名は SCHEMATA では schema_name、VIEWS では table_schema。
--   View 名は VIEWS の table_name。
SET schema_condition = CONCAT(
  IF(ARRAY_LENGTH(analysis_include_dataset_patterns) = 0, 'TRUE',
    (SELECT CONCAT('(', STRING_AGG(FORMAT("REGEXP_CONTAINS(schema_name, r'%s')", p), ' OR '), ')')
     FROM UNNEST(analysis_include_dataset_patterns) AS p)),
  IF(ARRAY_LENGTH(analysis_exclude_dataset_patterns) = 0, '',
    (SELECT CONCAT(' AND NOT (', STRING_AGG(FORMAT("REGEXP_CONTAINS(schema_name, r'%s')", p), ' OR '), ')')
     FROM UNNEST(analysis_exclude_dataset_patterns) AS p)));

SET view_dataset_condition = CONCAT(
  IF(ARRAY_LENGTH(analysis_include_dataset_patterns) = 0, 'TRUE',
    (SELECT CONCAT('(', STRING_AGG(FORMAT("REGEXP_CONTAINS(table_schema, r'%s')", p), ' OR '), ')')
     FROM UNNEST(analysis_include_dataset_patterns) AS p)),
  IF(ARRAY_LENGTH(analysis_exclude_dataset_patterns) = 0, '',
    (SELECT CONCAT(' AND NOT (', STRING_AGG(FORMAT("REGEXP_CONTAINS(table_schema, r'%s')", p), ' OR '), ')')
     FROM UNNEST(analysis_exclude_dataset_patterns) AS p)));

SET view_name_condition = CONCAT(
  IF(ARRAY_LENGTH(analysis_include_object_patterns) = 0, 'TRUE',
    (SELECT CONCAT('(', STRING_AGG(FORMAT("REGEXP_CONTAINS(table_name, r'%s')", p), ' OR '), ')')
     FROM UNNEST(analysis_include_object_patterns) AS p)),
  IF(ARRAY_LENGTH(analysis_exclude_object_patterns) = 0, '',
    (SELECT CONCAT(' AND NOT (', STRING_AGG(FORMAT("REGEXP_CONTAINS(table_name, r'%s')", p), ' OR '), ')')
     FROM UNNEST(analysis_exclude_object_patterns) AS p)));

-- 永続関数への呼び出しを 1 度だけ組み立てて使い回す。関数の場所は
-- udf_project_id / udf_dataset / udf_render_function_name で決まる。
-- 固定の設定はここで焼き込み、テンプレートだけを @sql_template で渡す。
-- 値は %T で埋める。条件文には引用符が入るので、%s だと壊れる。
SET render_call_sql = FORMAT(
  """SELECT `%s.%s.%s`(@sql_template, %T, %T, %T, %T, %T, %T, STRUCT(%T AS diff_hist, %T AS diff_latest, %T AS analyze_function, %T AS render_function, %T AS css_function), STRUCT(%T AS time_zone, %T AS retention_days, %T AS suffix_pattern), STRUCT(%T AS schema_condition, %T AS view_dataset_condition, %T AS view_name_condition))""",
  udf_project_id, udf_dataset, udf_sql_function_name,
  work_project_id, work_dataset, udf_project_id, udf_dataset,
  target_project_id, job_region,
  table_diff_hist, view_diff,
  udf_analyze_function_name, udf_render_function_name, udf_css_function_name,
  snapshot_time_zone, CAST(partition_expiration_days AS STRING), suffix_pattern,
  schema_condition, view_dataset_condition, view_name_condition);


-- 事前チェック。0 件のまま進むと空のテーブルができ、設定の間違いに気づけない。
SET sql_template = """
SELECT
  (SELECT COUNT(*)
   FROM `__TARGET_PROJECT__.region-__JOB_REGION__.INFORMATION_SCHEMA.SCHEMATA`
   WHERE REGEXP_CONTAINS(schema_name, r'__SUFFIX_PATTERN__') AND (__SCHEMA_COND__)),
  (SELECT COUNT(*)
   FROM `__TARGET_PROJECT__.region-__JOB_REGION__.INFORMATION_SCHEMA.VIEWS`
   WHERE (__VIEW_DATASET_COND__) AND (__VIEW_NAME_COND__))
""";
EXECUTE IMMEDIATE render_call_sql INTO rendered_sql USING sql_template AS sql_template;
ASSERT NOT REGEXP_CONTAINS(rendered_sql, r'__[A-Z0-9_]+__') AS
  '事前チェックの SQL に未展開のプレースホルダが残っています。';
EXECUTE IMMEDIATE rendered_sql INTO target_dataset_count, target_view_count;

ASSERT target_view_count > 0 AS
  '対象の View が 0 件です。@@location / analysis_include_dataset_patterns / analysis_include_object_patterns を確認してください。';
ASSERT target_dataset_count > 0 OR ARRAY_LENGTH(suffix_list) > 0 AS
  'suffix を持つデータセットが 0 件です。suffix_pattern / analysis_include_dataset_patterns を確認するか、suffix_list に直接並べてください。';


-- ---------------------------------------------------------------------
-- 1. 格納先（初回とスキーマを変えたときだけ）
--
--    CREATE OR REPLACE なので、実行すると既存の行はすべて消える。
--    パーティションに積んだ履歴（いつグループ構成が変わったか）も一緒に消える。
--    スケジュールドクエリに登録するのは CONFIGURATION と セクション 2 だけなので、
--    日次の生成でここが動くことはない。
-- ---------------------------------------------------------------------
SET sql_template = """
CREATE OR REPLACE TABLE `__T_DIFF_HIST__`
(
  snapshot_date   DATE           OPTIONS (description = '生成日'),
  base            STRING         OPTIONS (description = 'suffix を除いた View 名。Looker のキー。suffix を認識できなかった View は View 名そのもの'),
  view_count      INT64          OPTIONS (description = 'この base に属する View 数'),
  group_count     INT64          OPTIONS (description = 'ロジックのグループ数。1 なら全部同一'),
  has_multiple    BOOL           OPTIONS (description = 'group_count > 1。ロジック逸脱の検知用'),
  group_labels    ARRAY<STRING>  OPTIONS (description = 'タブ見出し（同一ロジックの suffix 列記）'),
  group_sizes     ARRAY<INT64>   OPTIONS (description = '各グループの View 数'),
  suffixes        ARRAY<STRING>  OPTIONS (description = '認識した suffix 一覧'),
  unmatched_count INT64          OPTIONS (description = 'suffix を認識できなかった View 数。1 ならこの行が単独表示の View'),
  diff_html       STRING         OPTIONS (description = '比較 HTML。Templated Record に渡す')
)
PARTITION BY snapshot_date
CLUSTER BY base
OPTIONS (
  description = 'suffix 違い View のロジック グループ比較（事前生成）',
  partition_expiration_days = __RETENTION_DAYS__
)
""";
EXECUTE IMMEDIATE render_call_sql INTO rendered_sql USING sql_template AS sql_template;
ASSERT NOT REGEXP_CONTAINS(rendered_sql, r'__[A-Z0-9_]+__') AS
  'CREATE TABLE の SQL に未展開のプレースホルダが残っています。';
EXECUTE IMMEDIATE rendered_sql;


-- ---------------------------------------------------------------------
-- 2. 生成（スケジュールドクエリに登録する本体）
--
--    同じ日に何度実行しても結果が同じになるよう、当日分を消してから入れる。
--    MERGE より DELETE + INSERT のほうが単純で、パーティション単位なので安い。
-- ---------------------------------------------------------------------
SET sql_template = """
DELETE FROM `__T_DIFF_HIST__`
WHERE snapshot_date = CURRENT_DATE('__TZ__')
""";
EXECUTE IMMEDIATE render_call_sql INTO rendered_sql USING sql_template AS sql_template;
ASSERT NOT REGEXP_CONTAINS(rendered_sql, r'__[A-Z0-9_]+__') AS
  'DELETE の SQL に未展開のプレースホルダが残っています。';
EXECUTE IMMEDIATE rendered_sql;

SET sql_template = """
INSERT INTO `__T_DIFF_HIST__`
WITH
-- suffix 一覧。suffix_list が空なら、対象データセットの名前から切り出す。
suffixes AS (
  SELECT suffix FROM UNNEST(
    IF(ARRAY_LENGTH(@suffix_list) > 0,
       @suffix_list,
       ARRAY(
         SELECT DISTINCT REGEXP_EXTRACT(schema_name, r'__SUFFIX_PATTERN__')
         FROM `__TARGET_PROJECT__.region-__JOB_REGION__.INFORMATION_SCHEMA.SCHEMATA`
         WHERE REGEXP_CONTAINS(schema_name, r'__SUFFIX_PATTERN__')
           AND (__SCHEMA_COND__)
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
  FROM `__TARGET_PROJECT__.region-__JOB_REGION__.INFORMATION_SCHEMA.VIEWS`
  WHERE (__VIEW_DATASET_COND__) AND (__VIEW_NAME_COND__)
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
-- 解析は base ごとに 1 回だけ。結果の JSON をこの段で持っておき、
-- メタデータは JSON から取り出し、HTML は描画の UDF に渡す。
-- JS UDF から別の UDF は呼べないので、この 2 段で合成する。
analyzed AS (
  SELECT
    base,
    `__UDF_ANALYZE__`(
      ARRAY_AGG(STRUCT(view_name, ddl) ORDER BY view_name),
      -- suffixes から組み立てた設定（全行で同じ値）
      (SELECT options_json FROM opts)
    ) AS analysis
  FROM keyed
  GROUP BY base
)
SELECT
  CURRENT_DATE('__TZ__') AS snapshot_date,
  base,
  CAST(JSON_VALUE(analysis, '$.viewCount')  AS INT64) AS view_count,
  CAST(JSON_VALUE(analysis, '$.groupCount') AS INT64) AS group_count,
  CAST(JSON_VALUE(analysis, '$.groupCount') AS INT64) > 1 AS has_multiple,
  JSON_VALUE_ARRAY(analysis, '$.groupLabels') AS group_labels,
  ARRAY(
    SELECT CAST(x AS INT64)
    FROM UNNEST(JSON_VALUE_ARRAY(analysis, '$.groupSizes')) AS x
  ) AS group_sizes,
  JSON_VALUE_ARRAY(analysis, '$.suffixes') AS suffixes,
  CAST(JSON_VALUE(analysis, '$.unmatchedCount') AS INT64) AS unmatched_count,
  `__UDF_RENDER__`(analysis, (SELECT options_json FROM opts)) AS diff_html
FROM analyzed
""";
EXECUTE IMMEDIATE render_call_sql INTO rendered_sql USING sql_template AS sql_template;
ASSERT NOT REGEXP_CONTAINS(rendered_sql, r'__[A-Z0-9_]+__') AS
  'INSERT の SQL に未展開のプレースホルダが残っています。';
EXECUTE IMMEDIATE rendered_sql
USING suffix_list AS suffix_list, analyze_options AS analyze_options;


-- ---------------------------------------------------------------------
-- 3. Looker Studio が読むビュー（最新スナップショットだけ・初回のみ）
--    名前は table_name_prefix + viewlgc_vw_t_diff + table_name_suffix。
-- ---------------------------------------------------------------------
SET sql_template = """
CREATE OR REPLACE VIEW `__V_DIFF__` AS
SELECT *
FROM `__T_DIFF_HIST__`
WHERE snapshot_date = (
  SELECT MAX(snapshot_date) FROM `__T_DIFF_HIST__`
)
""";
EXECUTE IMMEDIATE render_call_sql INTO rendered_sql USING sql_template AS sql_template;
ASSERT NOT REGEXP_CONTAINS(rendered_sql, r'__[A-Z0-9_]+__') AS
  'CREATE VIEW の SQL に未展開のプレースホルダが残っています。';
EXECUTE IMMEDIATE rendered_sql;


-- ---------------------------------------------------------------------
-- 4. テンプレートに貼る CSS（1 回取れば十分。template_style.html と同じ）
--
--    これだけはコメントのまま。毎回 8 KB の CSS を返しても邪魔なので、
--    必要なときに下の 4 行を外して実行する。
-- ---------------------------------------------------------------------
-- SET sql_template = """SELECT `__UDF_CSS__`(@analyze_options)""";
-- EXECUTE IMMEDIATE render_call_sql INTO rendered_sql USING sql_template AS sql_template;
-- ASSERT NOT REGEXP_CONTAINS(rendered_sql, r'__[A-Z0-9_]+__') AS 'CSS の SQL に未展開のプレースホルダが残っています。';
-- EXECUTE IMMEDIATE rendered_sql USING analyze_options AS analyze_options;


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
SET sql_template = """
SELECT
  '5-1 生成結果の中身'                AS check_name,
  base                              AS base_view_name,
  view_count                        AS views_in_base,
  group_count                       AS logic_group_count,
  group_labels                      AS logic_groups_by_suffix,
  unmatched_count                   AS suffix_unrecognized_views,
  LENGTH(diff_html)                 AS diff_html_length_chars
FROM `__V_DIFF__`
ORDER BY base_view_name
""";
EXECUTE IMMEDIATE render_call_sql INTO rendered_sql USING sql_template AS sql_template;
ASSERT NOT REGEXP_CONTAINS(rendered_sql, r'__[A-Z0-9_]+__') AS
  '5-1 の SQL に未展開のプレースホルダが残っています。';
EXECUTE IMMEDIATE rendered_sql;

-- 5-2 ロジックが割れている base（＝要確認のもの）
SET sql_template = """
SELECT
  '5-2 ロジックが割れている base'      AS check_name,
  base                              AS base_view_name,
  view_count                        AS views_in_base,
  group_count                       AS logic_group_count,
  group_labels                      AS logic_groups_by_suffix
FROM `__V_DIFF__`
WHERE has_multiple
ORDER BY logic_group_count DESC, base_view_name
""";
EXECUTE IMMEDIATE render_call_sql INTO rendered_sql USING sql_template AS sql_template;
ASSERT NOT REGEXP_CONTAINS(rendered_sql, r'__[A-Z0-9_]+__') AS
  '5-2 の SQL に未展開のプレースホルダが残っています。';
EXECUTE IMMEDIATE rendered_sql;

-- 5-3 suffix を認識できなかった View（単独で 1 行ずつ並ぶ）
SET sql_template = """
SELECT
  '5-3 suffix を認識できなかった View' AS check_name,
  base                              AS unrecognized_view_name,
  LENGTH(diff_html)                 AS diff_html_length_chars
FROM `__V_DIFF__`
WHERE unmatched_count > 0
ORDER BY unrecognized_view_name
""";
EXECUTE IMMEDIATE render_call_sql INTO rendered_sql USING sql_template AS sql_template;
ASSERT NOT REGEXP_CONTAINS(rendered_sql, r'__[A-Z0-9_]+__') AS
  '5-3 の SQL に未展開のプレースホルダが残っています。';
EXECUTE IMMEDIATE rendered_sql;

-- 5-4 対象データセットと suffix（CONFIGURATION と同じ条件）
SET sql_template = """
SELECT
  '5-4 対象データセットと suffix'      AS check_name,
  REGEXP_EXTRACT(schema_name, r'__SUFFIX_PATTERN__')  AS extracted_suffix,
  COUNT(*)                                            AS dataset_count,
  STRING_AGG(schema_name, ', ' ORDER BY schema_name)  AS dataset_names
FROM `__TARGET_PROJECT__.region-__JOB_REGION__.INFORMATION_SCHEMA.SCHEMATA`
WHERE REGEXP_CONTAINS(schema_name, r'__SUFFIX_PATTERN__') AND (__SCHEMA_COND__)
GROUP BY check_name, extracted_suffix
ORDER BY extracted_suffix
""";
EXECUTE IMMEDIATE render_call_sql INTO rendered_sql USING sql_template AS sql_template;
ASSERT NOT REGEXP_CONTAINS(rendered_sql, r'__[A-Z0-9_]+__') AS
  '5-4 の SQL に未展開のプレースホルダが残っています。';
EXECUTE IMMEDIATE rendered_sql;

-- 5-5 データセット別の対象 View 数
SET sql_template = """
SELECT
  '5-5 データセット別の対象 View 数'   AS check_name,
  table_schema                      AS dataset_name,
  COUNT(*)                          AS target_view_count
FROM `__TARGET_PROJECT__.region-__JOB_REGION__.INFORMATION_SCHEMA.VIEWS`
WHERE (__VIEW_DATASET_COND__) AND (__VIEW_NAME_COND__)
GROUP BY check_name, dataset_name
ORDER BY dataset_name
""";
EXECUTE IMMEDIATE render_call_sql INTO rendered_sql USING sql_template AS sql_template;
ASSERT NOT REGEXP_CONTAINS(rendered_sql, r'__[A-Z0-9_]+__') AS
  '5-5 の SQL に未展開のプレースホルダが残っています。';
EXECUTE IMMEDIATE rendered_sql;

-- 5-5b View 名の条件で落ちた View（対象のつもりのものが落ちていないか）
--      analysis_include_object_patterns / analysis_exclude_object_patterns が
--      空なら 0 件。
SET sql_template = """
SELECT
  '5-5b View 名の条件で落ちた View'    AS check_name,
  table_schema                      AS dataset_name,
  table_name                        AS excluded_view_name
FROM `__TARGET_PROJECT__.region-__JOB_REGION__.INFORMATION_SCHEMA.VIEWS`
WHERE (__VIEW_DATASET_COND__) AND NOT (__VIEW_NAME_COND__)
ORDER BY dataset_name, excluded_view_name
""";
EXECUTE IMMEDIATE render_call_sql INTO rendered_sql USING sql_template AS sql_template;
ASSERT NOT REGEXP_CONTAINS(rendered_sql, r'__[A-Z0-9_]+__') AS
  '5-5b の SQL に未展開のプレースホルダが残っています。';
EXECUTE IMMEDIATE rendered_sql;

-- 5-6 条件から外れたデータセット（対象のつもりのものが落ちていないか）
SET sql_template = """
SELECT
  '5-6 条件から外れたデータセット'     AS check_name,
  schema_name                       AS excluded_dataset_name
FROM `__TARGET_PROJECT__.region-__JOB_REGION__.INFORMATION_SCHEMA.SCHEMATA`
WHERE NOT (__SCHEMA_COND__)
ORDER BY excluded_dataset_name
""";
EXECUTE IMMEDIATE render_call_sql INTO rendered_sql USING sql_template AS sql_template;
ASSERT NOT REGEXP_CONTAINS(rendered_sql, r'__[A-Z0-9_]+__') AS
  '5-6 の SQL に未展開のプレースホルダが残っています。';
EXECUTE IMMEDIATE rendered_sql;

-- 5-7 グループ構成が変わった日（ロジック逸脱がいつ入ったか）
--     履歴が 1 日分しかなければ 0 件。
SET sql_template = """
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
  FROM `__T_DIFF_HIST__`
  WINDOW w AS (PARTITION BY base ORDER BY snapshot_date)
)
WHERE prev_labels IS NOT NULL AND prev_labels != curr_labels
ORDER BY changed_on DESC, base_view_name
""";
EXECUTE IMMEDIATE render_call_sql INTO rendered_sql USING sql_template AS sql_template;
ASSERT NOT REGEXP_CONTAINS(rendered_sql, r'__[A-Z0-9_]+__') AS
  '5-7 の SQL に未展開のプレースホルダが残っています。';
EXECUTE IMMEDIATE rendered_sql;
END;
