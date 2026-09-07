-- =====================================================================
-- 別リージョンの View メタデータを GCS へ書き出す（拠点の外側で流す）
--
-- ※ このファイルを直接編集する。生成物ではない。
--    設定は CONFIGURATION の DECLARE だけ。ほかに設定を置く場所はない。
--
-- **なぜこれが要るのか。**
-- BigQuery は 1 ジョブ = 1 ロケーション。`region-asia-southeast1` の
-- INFORMATION_SCHEMA は、そのリージョンで走っているジョブからしか読めない。
-- 拠点（asia-northeast1）のジョブから読もうとすると
--   Not found: Dataset ... was not found in location asia-northeast1
-- で落ちる。テーブルの JOIN も UNION も同じ。**だから build_table.sql に
-- UNION ALL を 1 行足す形の解決は無い。** メタデータをどこかで 1 回運ぶしかない。
--
-- 運ぶのはメタデータだけ。データそのものは 1 バイトも動かない。
-- view_definition は 1 本あたり数 KB なので、View が 1000 本でも数 MB。
--
-- **バケットは 2 つ要る。**
-- BigQuery は GCS との間で「同じロケーション」を要求する。書き出す側の
-- データセットが asia-southeast1 なら、バケットも asia-southeast1
-- （かそれを含むデュアルリージョン）でなければならない。読み込む側も同じで、
-- asia-northeast1 のデータセットには asia-northeast1 のバケットが要る。
-- そして **asia-northeast1 と asia-southeast1 を組にしたデュアルリージョンは
-- 無い**（ASIA1 は asia-northeast1 ＋ asia-northeast2）。1 つのバケットで
-- 両方を兼ねることはできない。
--
--   asia-southeast1                     asia-northeast1
--   ┌──────────────────┐               ┌──────────────────┐
--   │ INFORMATION_SCHEMA│               │                  │
--   │        ↓ このファイル│               │                  │
--   │ gs://…-se1/…      │ ── コピー ──→ │ gs://…-ne1/…     │
--   └──────────────────┘  （GCS → GCS）  │        ↓          │
--                                        │ cross_region_    │
--                                        │   import.sql     │
--                                        └──────────────────┘
--
-- 真ん中のコピーは SQL では書けない。Storage Transfer Service に
-- ジョブを 1 本作るのがいちばん手間が少ない（コンソールで設定でき、
-- スケジュールも持てる）。
--
-- 形式は AVRO。列名と型がそのまま往復するので、読み込む側でスキーマを
-- 書かなくてよい。CSV だと view_definition の改行と引用符が地雷になる。
--
-- 実行するリージョンごとに 1 本ずつスケジュールドクエリを作る。拠点
-- （asia-northeast1）ぶんは運ぶ必要がないので、このファイルは要らない。
-- =====================================================================
SET @@location = 'asia-southeast1';

BEGIN
-- ---------------------------------------------------------------------
-- CONFIGURATION（書き換えるのはここだけ）
--
--   [A] 環境ごとに必ず見るもの
--   [C] 導出・内部用。編集しない
--
--   リージョンは先頭の SET @@location が唯一の置き場所。job_region は
--   そこから受け取る。SET @@location は DECLARE より前に置く。
-- ---------------------------------------------------------------------
-- [A] 環境ごとに必ず見るもの ------------------------------------------
-- 書き出し先。**このスクリプトを流すリージョンと同じロケーションの
-- バケット**を指すこと（違うと EXPORT DATA が落ちる）。
-- 末尾に / は付けない。下でリージョン名とファイル名を足す。
DECLARE gcs_export_prefix STRING DEFAULT 'gs://CHANGE-ME-se1/viewlgc';

-- 解析対象のデータセット / View。**拠点側（build_table.sql）と同じ値にする。**
-- 食い違うと、運んだ側と拠点側で対象がずれる。ずれても落ちないので、
-- 「あるはずの View が出てこない」という分かりにくい形で表に出る。
DECLARE analysis_include_dataset_patterns ARRAY<STRING> DEFAULT [r'_([A-Za-z]{4})$'];
DECLARE analysis_exclude_dataset_patterns ARRAY<STRING> DEFAULT [];
DECLARE analysis_include_object_patterns ARRAY<STRING> DEFAULT [];
DECLARE analysis_exclude_object_patterns ARRAY<STRING> DEFAULT [];

-- [C] 導出・内部用。編集しない ----------------------------------------
DECLARE job_region STRING DEFAULT @@location;
DECLARE default_project_id STRING;
DECLARE target_project_id  STRING DEFAULT NULL;  -- 読み取り対象

-- include / exclude から組み立てる条件文。見る列が違うので 2 本作る。
DECLARE schema_condition       STRING;  -- SCHEMATA.schema_name
DECLARE view_dataset_condition STRING;  -- table_schema
DECLARE view_name_condition    STRING;  -- table_name

-- EXPORT 文の型。uri の組み立てを 1 か所にまとめる。
-- uri には * がちょうど 1 つ要る（BigQuery が分割して書くため）。
DECLARE export_stmt STRING DEFAULT
  "EXPORT DATA OPTIONS(uri = '%s/%s/%s-*.avro', format = 'AVRO', overwrite = true) AS %s";

-- 書き出す 5 本の SELECT。下で組み立てる。
DECLARE sql_schemata     STRING;
DECLARE sql_views        STRING;
DECLARE sql_columns      STRING;
DECLARE sql_field_paths  STRING;
DECLARE sql_table_opts   STRING;

-- 件数。マニフェストに載せて、拠点側で「全部届いたか」を確かめる材料にする。
DECLARE n_schemata    INT64;
DECLARE n_views       INT64;
DECLARE n_columns     INT64;
DECLARE n_field_paths INT64;
DECLARE n_table_opts  INT64;


-- 実行中のプロジェクトを INFORMATION_SCHEMA.SCHEMATA から自動検出する
-- （catalog_name = ジョブが動いているプロジェクト）。リージョン修飾の
-- 識別子はパラメータにできないので @@location から組み立てる。
-- build_table.sql と同じ書き方。
EXECUTE IMMEDIATE FORMAT(
  "SELECT DISTINCT catalog_name FROM `region-%s`.INFORMATION_SCHEMA.SCHEMATA LIMIT 1",
  @@location
) INTO default_project_id;
ASSERT default_project_id IS NOT NULL AS
  'プロジェクト ID を自動検出できません（このリージョンにデータセットが無い？）。target_project_id にリテラルを入れて固定してください。';
SET target_project_id = COALESCE(target_project_id, default_project_id);

ASSERT NOT STARTS_WITH(gcs_export_prefix, 'gs://CHANGE-ME') AS
  'gcs_export_prefix を書き換えてください（このリージョンと同じロケーションのバケットを指すこと）。';
ASSERT STARTS_WITH(gcs_export_prefix, 'gs://') AND NOT ENDS_WITH(gcs_export_prefix, '/') AS
  'gcs_export_prefix は gs:// で始まり、末尾に / を付けない形にしてください。';


-- 条件文。build_table.sql と同じ組み立て方にそろえてある。
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


-- ---------------------------------------------------------------------
-- 書き出す 5 本を組み立てる
--
-- 列は build_table.sql が実際に読むものだけ。**列を減らさない。** 拾う列を
-- 増やしたくなったときに、拠点側だけ直しても届かない（ここが上流）。
-- どの列がどこで使われているかは build_table.sql の同名の CTE を見る。
--
-- source_region を全部に持たせる。運んだ先で拠点のぶんと混ざるので、
-- 行がどこから来たのかを行自身が持っていないと追えなくなる。
-- ---------------------------------------------------------------------
-- suffix の抽出元（build_table.sql の suffix_base）
SET sql_schemata = FORMAT("""
SELECT %T AS source_region, catalog_name, schema_name
FROM `%s.region-%s.INFORMATION_SCHEMA.SCHEMATA`
WHERE (%s)
""", job_region, target_project_id, job_region, schema_condition);

-- 解析の本体（build_table.sql の src）。
-- TABLES.ddl ではなく VIEWS.view_definition を使う理由は build_table.sql に
-- 書いてある（ddl には View ごとに違う OPTIONS が付き、全部が別グループに割れる）。
SET sql_views = FORMAT("""
SELECT %T AS source_region, table_schema, table_name, view_definition
FROM `%s.region-%s.INFORMATION_SCHEMA.VIEWS`
WHERE (%s) AND (%s)
""", job_region, target_project_id, job_region,
     view_dataset_condition, view_name_condition);

-- カラム定義タブ（build_table.sql の cols_raw）
SET sql_columns = FORMAT("""
SELECT %T AS source_region, table_schema, table_name, column_name,
       ordinal_position, data_type, is_nullable
FROM `%s.region-%s.INFORMATION_SCHEMA.COLUMNS`
WHERE (%s) AND (%s)
""", job_region, target_project_id, job_region,
     view_dataset_condition, view_name_condition);

-- カラムの説明とネストした項目（build_table.sql の col_paths）
SET sql_field_paths = FORMAT("""
SELECT %T AS source_region, table_schema, table_name, column_name,
       field_path, data_type, description
FROM `%s.region-%s.INFORMATION_SCHEMA.COLUMN_FIELD_PATHS`
WHERE (%s) AND (%s)
""", job_region, target_project_id, job_region,
     view_dataset_condition, view_name_condition);

-- View の description とラベル（build_table.sql の view_opts / view_labels）。
-- **option_name で絞る。** TABLE_OPTIONS はテーブルの分も他の option も
-- 持っているので、そのまま運ぶと要らない行のほうが多くなる。
SET sql_table_opts = FORMAT("""
SELECT %T AS source_region, table_schema, table_name, option_name, option_value
FROM `%s.region-%s.INFORMATION_SCHEMA.TABLE_OPTIONS`
WHERE option_name IN ('description', 'labels')
  AND (%s) AND (%s)
""", job_region, target_project_id, job_region,
     view_dataset_condition, view_name_condition);


-- ---------------------------------------------------------------------
-- 件数を先に数える
--
-- **0 件のまま書き出さない。** 設定を間違えていると空の avro が並び、
-- 拠点側は「このリージョンには View が無い」と読んで黙って通してしまう。
-- 落ちるならここで落ちるほうがよい。
-- ---------------------------------------------------------------------
EXECUTE IMMEDIATE FORMAT(
  "SELECT (SELECT COUNT(*) FROM (%s)), (SELECT COUNT(*) FROM (%s)), (SELECT COUNT(*) FROM (%s)), (SELECT COUNT(*) FROM (%s)), (SELECT COUNT(*) FROM (%s))",
  sql_schemata, sql_views, sql_columns, sql_field_paths, sql_table_opts)
INTO n_schemata, n_views, n_columns, n_field_paths, n_table_opts;

ASSERT n_views > 0 AS
  '対象の View が 0 件です。@@location / analysis_include_dataset_patterns / analysis_include_object_patterns を確認してください。';


-- ---------------------------------------------------------------------
-- 書き出し
--
-- パスにリージョン名を挟む（…/viewlgc/asia-southeast1/views-*.avro）。
-- リージョンを増やすときは、このファイルを @@location と gcs_export_prefix
-- だけ変えてもう 1 本作り、拠点側の source_regions に足す。
-- ---------------------------------------------------------------------
EXECUTE IMMEDIATE FORMAT(export_stmt, gcs_export_prefix, job_region, 'schemata',    sql_schemata);
EXECUTE IMMEDIATE FORMAT(export_stmt, gcs_export_prefix, job_region, 'views',       sql_views);
EXECUTE IMMEDIATE FORMAT(export_stmt, gcs_export_prefix, job_region, 'columns',     sql_columns);
EXECUTE IMMEDIATE FORMAT(export_stmt, gcs_export_prefix, job_region, 'field_paths', sql_field_paths);
EXECUTE IMMEDIATE FORMAT(export_stmt, gcs_export_prefix, job_region, 'table_opts',  sql_table_opts);

-- マニフェスト。**いちばん最後に書く。**
--
-- GCS → GCS のコピーは順序を約束しないので、拠点側が「コピーの途中」を
-- 読むことがありうる。そのとき静かに欠けた状態で解析されるのがいちばん困る。
-- 件数と書き出し時刻をここに載せておき、拠点側で
--   ・collected_at が古くないか
--   ・読み込んだ行数がここの件数と一致するか
-- の 2 つを確かめる。どちらも通れば、少なくとも「同じ 1 回ぶんの avro が
-- 全部届いている」ことは言える。
--
-- **時刻は STRING で載せる。** TIMESTAMP を avro にすると論理型として
-- 書かれ、読み込み側が use_avro_logical_types を付けないと INT64（マイクロ秒）
-- として戻る。そうなっても落ちずに「比較が通らない」形で出るだけなので、
-- 往復の仕方に依存しない ISO 8601 の文字列にしておく。
EXECUTE IMMEDIATE FORMAT(export_stmt, gcs_export_prefix, job_region, 'manifest',
  FORMAT("""
SELECT
  %T AS source_region,
  FORMAT_TIMESTAMP('%%Y-%%m-%%dT%%H:%%M:%%SZ', CURRENT_TIMESTAMP()) AS collected_at_iso,
  %d AS n_schemata,
  %d AS n_views,
  %d AS n_columns,
  %d AS n_field_paths,
  %d AS n_table_opts
""", job_region, n_schemata, n_views, n_columns, n_field_paths, n_table_opts));

END;
