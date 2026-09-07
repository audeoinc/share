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
-- **2 段構えなのは EXPORT DATA が INFORMATION_SCHEMA を読めないため。**
-- 直に `EXPORT DATA … AS SELECT … FROM INFORMATION_SCHEMA.VIEWS` とは書けない
-- （メタデータのテーブルは参照できない）。いったん普通のテーブルに落とし、
-- そのテーブルを書き出す。
--
--   INFORMATION_SCHEMA ── CTAS ──→ viewlgc_stg_*（このリージョン）
--                                        └─ EXPORT DATA ──→ GCS
--
-- 落とした viewlgc_stg_* は、拠点側の viewlgc_imp_* と同じ形をしている。
-- 書き出しが失敗したときに、どこまでできていたかを直に見られる。
--
-- **バケットは 1 つ。書き出したものを拠点から直に読む。**
-- 書き出す側は同一ロケーションが要る（EXPORT DATA の宛先は、書き出す
-- データセットと同じロケーションでなければならない）ので、バケットは
-- このリージョン（asia-southeast1）に置く。
-- 読み込む側にその縛りは無く、**拠点の LOAD DATA からこのバケットを
-- そのまま読める**（実環境で確認済み。別リージョンなので転送料金は
-- かかるが、運ぶのは数 MB のメタデータだけ）。
-- GCS → GCS のコピーも、拠点側のバケットも要らない。
--
--   asia-southeast1                     asia-northeast1（拠点）
--   ┌──────────────────┐               ┌──────────────────┐
--   │ INFORMATION_SCHEMA│               │ cross_region_    │
--   │        ↓ CTAS     │               │   import.sql     │
--   │ viewlgc_stg_*     │               │        ↓          │
--   │        ↓ EXPORT   │               │ build_table.sql  │
--   │ gs://…-se1/…      │ ←─ LOAD DATA ─│                  │
--   └──────────────────┘               └──────────────────┘
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

-- 中継のテーブルを置くデータセット。**このリージョンに作ってあること。**
-- INFORMATION_SCHEMA を直に書き出せないので、一度ここへ落とす。
DECLARE work_dataset STRING DEFAULT 'ops_meta';

-- 解析対象のデータセット / View。**拠点側（build_table.sql）と同じ値にする。**
-- 食い違うと、運んだ側と拠点側で対象がずれる。ずれても落ちないので、
-- 「あるはずの View が出てこない」という分かりにくい形で表に出る。
DECLARE analysis_include_dataset_patterns ARRAY<STRING> DEFAULT [r'_([A-Za-z]{4})$'];
DECLARE analysis_exclude_dataset_patterns ARRAY<STRING> DEFAULT [];
DECLARE analysis_include_object_patterns ARRAY<STRING> DEFAULT [];
DECLARE analysis_exclude_object_patterns ARRAY<STRING> DEFAULT [];

-- 命名。**build_table.sql / cross_region_import.sql と同じ値にすること。**
-- 食い違うと、拠点側がこのファイルの作ったテーブルを見つけられない。
--
-- project_token_pattern は、自動検出したプロジェクト ID からトークンを
-- 切り出す正規表現（キャプチャがあればグループ 1）。切り出した値が、
-- 下の 3 つに書いた '{project_token}' をすべて置き換える。例えば
-- プロジェクト 'mycompany-prod-123' に r'-([^-]+)-' なら 'prod' になるので、
-- table_name_prefix='{project_token}_' が 'prod_' になる。
-- 既定は最初のハイフン区切り。build_table.sql と合わせること。
DECLARE project_token_pattern STRING DEFAULT r'^([^-]+)';
DECLARE system_name STRING DEFAULT 'viewlgc';
DECLARE table_name_prefix STRING DEFAULT '';
DECLARE table_name_suffix STRING DEFAULT '';

-- [C] 導出・内部用。編集しない ----------------------------------------
DECLARE job_region STRING DEFAULT @@location;
DECLARE default_project_id STRING;
DECLARE target_project_id  STRING DEFAULT NULL;  -- 読み取り対象
DECLARE work_project_id    STRING DEFAULT NULL;  -- 中継テーブルの置き場所
DECLARE project_token      STRING;

-- include / exclude から組み立てる条件文。見る列が違うので 3 本作る。
DECLARE schema_condition       STRING;  -- SCHEMATA.schema_name
DECLARE view_dataset_condition STRING;  -- table_schema
DECLARE view_name_condition    STRING;  -- table_name

-- 中継テーブルを作る文と、それを書き出す文。
-- uri には * がちょうど 1 つ要る（BigQuery が分割して書くため）。
DECLARE ctas_stmt STRING DEFAULT
  "CREATE OR REPLACE TABLE `%s` AS %s";
DECLARE export_stmt STRING DEFAULT
  "EXPORT DATA OPTIONS(uri = '%s/%s/%s-*.avro', format = 'AVRO', overwrite = true) AS SELECT * FROM `%s`";

-- 書き出す 5 本の SELECT。下で組み立てる。
DECLARE sql_schemata    STRING;
DECLARE sql_views       STRING;
DECLARE sql_columns     STRING;
DECLARE sql_field_paths STRING;
DECLARE sql_table_opts  STRING;

-- 種類と中身の組。中継 → 書き出しを 1 つのループで回すためにまとめる。
DECLARE parts ARRAY<STRUCT<kind STRING, body STRING>>;
DECLARE counts ARRAY<STRUCT<kind STRING, n INT64>> DEFAULT [];
DECLARE i INT64 DEFAULT 0;
DECLARE kind         STRING;
DECLARE stg_fqn      STRING;
DECLARE n_rows       INT64;
DECLARE collected_iso STRING;
DECLARE manifest_sql  STRING;
DECLARE n_views       INT64;


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
SET work_project_id   = COALESCE(work_project_id,   default_project_id);

-- 名前を組み立てる前に '{project_token}' を置き換える。
-- build_table.sql と同じ手順・同じ順序にそろえてある。ここを省くと、
-- build_table.sql から prefix をそのまま持ってきたときに
-- '{project_token}_viewlgc_…' という名前のテーブルを作りに行って落ちる。
SET project_token =
  COALESCE(REGEXP_EXTRACT(default_project_id, project_token_pattern), '');
SET work_dataset      = REPLACE(work_dataset,      '{project_token}', project_token);
SET table_name_prefix = REPLACE(table_name_prefix, '{project_token}', project_token);
SET table_name_suffix = REPLACE(table_name_suffix, '{project_token}', project_token);

ASSERT REGEXP_CONTAINS(work_dataset, r'^[A-Za-z0-9_]+$') AS
  'work_dataset は英数字と _ だけにしてください（置換されていない {project_token} が残っていませんか）。';
ASSERT REGEXP_CONTAINS(system_name, r'^[A-Za-z0-9_]+$') AS
  'system_name は英数字と _ だけにしてください。';
ASSERT REGEXP_CONTAINS(table_name_prefix, r'^[A-Za-z0-9_-]*$') AS
  'table_name_prefix は英数字と _ - だけにしてください（置換されていない {project_token} が残っていませんか）。';
ASSERT REGEXP_CONTAINS(table_name_suffix, r'^[A-Za-z0-9_-]*$') AS
  'table_name_suffix は英数字と _ - だけにしてください（置換されていない {project_token} が残っていませんか）。';

ASSERT NOT STARTS_WITH(gcs_export_prefix, 'gs://CHANGE-ME') AS
  'gcs_export_prefix を書き換えてください（このリージョンと同じロケーションのバケットを指すこと）。';
ASSERT STARTS_WITH(gcs_export_prefix, 'gs://') AND NOT ENDS_WITH(gcs_export_prefix, '/') AS
  'gcs_export_prefix は gs:// で始まり、末尾に / を付けない形にしてください。';

SET collected_iso = FORMAT_TIMESTAMP('%Y-%m-%dT%H:%M:%SZ', CURRENT_TIMESTAMP());


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

-- 種類の文字列は cross_region_import.sql の kinds と 1 対 1。
SET parts = [
  STRUCT('schemata'    AS kind, sql_schemata    AS body),
  STRUCT('views',           sql_views),
  STRUCT('columns',         sql_columns),
  STRUCT('field_paths',     sql_field_paths),
  STRUCT('table_opts',      sql_table_opts)
];


-- ---------------------------------------------------------------------
-- 中継テーブルに落として、それを書き出す
--
-- CTAS と EXPORT を 1 種類ずつ交互に流す。**CREATE OR REPLACE TABLE は
-- 1 文で差し替わる**ので、中継テーブルを直接見ている人がいても
-- 「空のテーブル」が見える瞬間が無い（build_table.sql と同じ考え方）。
-- ---------------------------------------------------------------------
WHILE i < ARRAY_LENGTH(parts) DO
  SET kind = parts[OFFSET(i)].kind;
  SET stg_fqn = FORMAT('%s.%s.%s', work_project_id, work_dataset,
    CONCAT(table_name_prefix, system_name, '_stg_', kind, table_name_suffix));

  EXECUTE IMMEDIATE FORMAT(ctas_stmt, stg_fqn, parts[OFFSET(i)].body);
  EXECUTE IMMEDIATE FORMAT("SELECT COUNT(*) FROM `%s`", stg_fqn) INTO n_rows;
  SET counts = ARRAY_CONCAT(counts, [STRUCT(kind AS kind, n_rows AS n)]);

  -- **0 件のまま書き出さない。** 設定を間違えていると空の avro が並び、
  -- 拠点側は「このリージョンには View が無い」と読んで黙って通してしまう。
  -- 落ちるならここで落ちるほうがよい。View 以外は 0 でもありうる
  -- （ラベルも description も付いていない、など）ので views だけ見る。
  IF kind = 'views' THEN SET n_views = n_rows; END IF;

  EXECUTE IMMEDIATE FORMAT(export_stmt,
    gcs_export_prefix, job_region, kind, stg_fqn);
  SET i = i + 1;
END WHILE;

ASSERT n_views > 0 AS
  '対象の View が 0 件です。@@location / analysis_include_dataset_patterns / analysis_include_object_patterns を確認してください。';


-- ---------------------------------------------------------------------
-- マニフェスト。**いちばん最後に書く。**
--
-- 書き出しは 5 本を順に流すので、views は新しいのに table_opts はまだ前回、
-- という瞬間が実際に存在する。拠点側がその瞬間を読むと、静かに欠けた状態で
-- 解析されてしまう。件数と書き出し時刻をここに載せておき、拠点側で
--   ・collected_at_iso が古くないか
--   ・読み込んだ行数がここの件数と一致するか
-- を確かめる。両方通れば「同じ 1 回ぶんの avro が全部届いている」と言える。
--
-- 縦持ち（1 種類 1 行）にしてある。拠点側の突き合わせが kind で JOIN する
-- だけになり、種類を増やしてもマニフェストの形が変わらない。
--
-- **時刻は STRING で載せる。** TIMESTAMP を avro にすると論理型として
-- 書かれ、読み込み側が use_avro_logical_types を付けないと INT64（マイクロ秒）
-- として戻る。そうなっても落ちずに「比較が通らない」形で出るだけなので、
-- 往復の仕方に依存しない ISO 8601 の文字列にしておく。
-- ---------------------------------------------------------------------
SET manifest_sql = (
  SELECT STRING_AGG(
    FORMAT("SELECT %T AS source_region, %T AS collected_at_iso, %T AS kind, %d AS n_rows",
           job_region, collected_iso, c.kind, c.n),
    ' UNION ALL ' ORDER BY c.kind)
  FROM UNNEST(counts) AS c);

SET stg_fqn = FORMAT('%s.%s.%s', work_project_id, work_dataset,
  CONCAT(table_name_prefix, system_name, '_stg_manifest', table_name_suffix));
EXECUTE IMMEDIATE FORMAT(ctas_stmt, stg_fqn, manifest_sql);
EXECUTE IMMEDIATE FORMAT(export_stmt,
  gcs_export_prefix, job_region, 'manifest', stg_fqn);

END;
