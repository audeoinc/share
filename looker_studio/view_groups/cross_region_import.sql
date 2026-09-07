-- =====================================================================
-- 別リージョンの View メタデータを GCS から取り込む（拠点で流す）
--
-- ※ このファイルを直接編集する。生成物ではない。
--    設定は CONFIGURATION の DECLARE だけ。ほかに設定を置く場所はない。
--
-- cross_region_export.sql が送り元のリージョンで書き出した avro を、
-- **拠点から直に読んで**テーブルに落とす。落とした 5 本を build_table.sql が
-- 拠点自身の INFORMATION_SCHEMA と UNION ALL して解析する。
--
--   asia-southeast1                     asia-northeast1（拠点）
--   ┌──────────────────┐               ┌────────────────────────┐
--   │ INFORMATION_SCHEMA│               │ INFORMATION_SCHEMA      │
--   │        ↓ export   │               │            ＋            │
--   │ gs://…-se1/…      │ ←─ LOAD DATA ─│            ↓ このファイル │
--   └──────────────────┘               │ viewlgc_t_meta_*（5 本）    │
--                                       │            ↓            │
--                                       │ build_table.sql         │
--                                       └────────────────────────┘
--
-- **バケットは送り元の 1 つだけ。** 書き出す側は同一ロケーションが要る
-- （EXPORT DATA の宛先は書き出すデータセットと同じロケーション）が、
-- **読み込む側にその縛りは無い。** 拠点の LOAD DATA から asia-southeast1 の
-- バケットをそのまま読める（実環境で確認済み）。別リージョンなので転送
-- 料金はかかるが、運ぶのは数 MB のメタデータだけ。
-- GCS → GCS のコピーも、拠点側のバケットも、転送サービスも要らない。
--
-- バケットは sources の行ごとに持たせてある。事情があって拠点側へ
-- コピーしてから読みたいリージョンが出てきたら、その行の gcs_prefix だけ
-- 拠点側のバケットに向ければよい（スクリプトは変わらない）。
--
-- LOAD DATA OVERWRITE はテーブルが無ければ作り、あれば中身とスキーマごと
-- 差し替える。**1 文で差し替わるので、読み手から見て「空のテーブル」が
-- 見える瞬間が無い。** build_table.sql が同じ理由で
-- CREATE OR REPLACE TABLE ... AS SELECT を使っているのと同じ考え方。
--
-- 実行順序: 書き出し → **このファイル** → build_table.sql。
-- スケジュールドクエリにするなら、build_table.sql より前に置く。
-- 書き出しは別リージョンの別スケジュールなので、両者が擦れ違うことは
-- ありうる。そのための検証が下の 3 つ。
-- =====================================================================
SET @@location = 'asia-northeast1';

BEGIN
-- ---------------------------------------------------------------------
-- CONFIGURATION（書き換えるのはここだけ）
-- ---------------------------------------------------------------------
-- [A] 環境ごとに必ず見るもの ------------------------------------------
-- 取り込む送り元と、その avro をどこから読むか。
-- cross_region_export.sql を流したリージョンを 1 行ずつ並べる。
-- **拠点自身（asia-northeast1）は入れない**（運ぶ必要が無く、入れると
-- 同じ行が 2 回入る）。増やすときはここに 1 行足すだけ。
--
-- **gcs_prefix は送り元ごとに持たせてある。** 読み方が 2 通りあるため。
--
--   (a) 送り元のバケットを直に読む（既定）
--       gcs_prefix は**送り元側のバケット**を指す。
--       gs://…-se1/viewlgc/asia-southeast1/views-*.avro
--       cross_region_export.sql が書いた場所をそのまま読む。コピーは無い。
--
--   (b) 拠点のバケットへコピーしてから読む
--       gcs_prefix は**拠点側のバケット**を指す。
--       gs://…-ne1/viewlgc/asia-southeast1/views-*.avro
--       転送料金を避けたい、送り元のバケットを拠点から読ませたくない、
--       といった事情があるときだけ。GCS → GCS のコピーが別に要る
--       （Storage Transfer Service など）。そのときは
--       **「転送元にないオブジェクトを転送先から削除」を有効にすること。**
--       EXPORT DATA は書き出す側のバケットしか掃除しないので、前回
--       2 分割で書かれ今回 1 つで足りたとき、宛先に前回の 2 つ目が残る。
--       ワイルドカードで読むので古い行が混ざり、下の件数の突き合わせが
--       毎回落ちる。
--
-- リージョンごとに (a)(b) が混ざっていてもよい。末尾に / は付けない。
DECLARE sources ARRAY<STRUCT<source_region STRING, gcs_prefix STRING>> DEFAULT [
  STRUCT('asia-southeast1' AS source_region,
         'gs://CHANGE-ME-se1/viewlgc' AS gcs_prefix)
];

-- 取り込んだメタデータの古さの上限（時間）。書き出しからこれ以上経って
-- いたら落とす。**運んだ側が止まっているのに、拠点だけ動き続けて
-- 「昨日のメタデータで解析した結果」を今日の顔で出すのを防ぐ。**
-- 日次で回すなら 36 時間くらい（1 日ぶんの遅れは許し、2 日は許さない）。
DECLARE max_staleness_hours INT64 DEFAULT 36;

-- 取り込み先のデータセット。build_table.sql の work_dataset と同じでよい。
DECLARE work_dataset STRING DEFAULT 'ops_meta';

-- 命名。**build_table.sql と同じ値にすること。** 拠点側はこのファイルが
-- 作ったテーブルを同じ規則で組み立てて読むので、食い違うと見つからない。
--
-- project_token_pattern は、自動検出したプロジェクト ID からトークンを
-- 切り出す正規表現（キャプチャがあればグループ 1）。切り出した値が、
-- 下の 3 つと work_dataset に書いた '{project_token}' をすべて置き換える。
-- 例えばプロジェクト 'mycompany-prod-123' に r'-([^-]+)-' なら 'prod' に
-- なるので、table_name_prefix='{project_token}_' が 'prod_' になる。
-- 既定は最初のハイフン区切り。build_table.sql と合わせること。
DECLARE project_token_pattern STRING DEFAULT r'^([^-]+)';
DECLARE system_name STRING DEFAULT 'viewlgc';
DECLARE table_name_prefix STRING DEFAULT '';
DECLARE table_name_suffix STRING DEFAULT '';

-- [C] 導出・内部用。編集しない ----------------------------------------
DECLARE job_region STRING DEFAULT @@location;
DECLARE default_project_id STRING;
DECLARE work_project_id    STRING DEFAULT NULL;  -- テーブルの置き場所
DECLARE project_token      STRING;
-- 送り元のリージョン名だけを取り出したもの。下の検証で使う。
-- DECLARE の DEFAULT では組み立てない（副問い合わせを書ける場所が
-- 処理系で違うので、確実に通る SET のほうに寄せる）。
DECLARE source_regions ARRAY<STRING>;

-- 取り込む 5 本 ＋ マニフェスト。名前は build_table.sql と同じ規則で組み立てる
-- （prefix + system_name + '_' + 区分 + 基本名 + suffix。区分は 't_'）。
-- **送り元の中継テーブルとまったく同じ名前。** 中身もどちらも「収集した
-- メタデータのスナップショット」で、どのリージョンのものかは source_region 列が
-- 持っている。データセットはリージョンごとに別なので衝突しない。
-- 種類の文字列は cross_region_export.sql の parts と 1 対 1。
DECLARE kinds ARRAY<STRING> DEFAULT
  ['schemata', 'views', 'columns', 'field_paths', 'table_opts', 'manifest'];
DECLARE kind          STRING;
DECLARE table_fqn     STRING;
DECLARE uris_literal  STRING;
DECLARE i             INT64 DEFAULT 0;

-- 検証用
DECLARE manifest_fqn    STRING;
DECLARE missing_regions ARRAY<STRING>;
DECLARE stale_regions   ARRAY<STRING>;
DECLARE count_mismatch  STRING;


-- 実行中のプロジェクトを自動検出する（build_table.sql と同じ書き方）。
EXECUTE IMMEDIATE FORMAT(
  "SELECT DISTINCT catalog_name FROM `region-%s`.INFORMATION_SCHEMA.SCHEMATA LIMIT 1",
  @@location
) INTO default_project_id;
ASSERT default_project_id IS NOT NULL AS
  'プロジェクト ID を自動検出できません。work_project_id にリテラルを入れて固定してください。';
SET work_project_id = COALESCE(work_project_id, default_project_id);

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

SET source_regions = ARRAY(SELECT source_region FROM UNNEST(sources) ORDER BY source_region);

ASSERT ARRAY_LENGTH(sources) > 0 AS
  'sources が空です。運んでくる送り元を 1 つ以上並べてください。';
ASSERT NOT EXISTS(
  SELECT 1 FROM UNNEST(sources) AS s WHERE STARTS_WITH(s.gcs_prefix, 'gs://CHANGE-ME')) AS
  'sources の gcs_prefix を書き換えてください。';
ASSERT NOT EXISTS(
  SELECT 1 FROM UNNEST(sources) AS s
  WHERE NOT STARTS_WITH(s.gcs_prefix, 'gs://') OR ENDS_WITH(s.gcs_prefix, '/')) AS
  'gcs_prefix は gs:// で始まり、末尾に / を付けない形にしてください。';
ASSERT ARRAY_LENGTH(source_regions) = ARRAY_LENGTH(
  ARRAY(SELECT DISTINCT source_region FROM UNNEST(sources))) AS
  'sources に同じ source_region が 2 回出てきます。同じ行が 2 回入ります。';
ASSERT job_region NOT IN UNNEST(source_regions) AS
  '拠点自身のリージョンが sources に入っています。拠点のぶんは build_table.sql が直接読むので、ここに入れると同じ行が 2 回入ります。';


-- ---------------------------------------------------------------------
-- 取り込み
--
-- 1 種類につき 1 テーブル。送り元が複数あっても 1 本にまとめる
-- （行は source_region 列で区別できる）。
--
-- **uri は送り元ごとに 1 本ずつ並べる。** BigQuery の読み込み URI に置ける
-- ワイルドカードは 1 つだけなので、…/*/views-*.avro とは書けない。
-- 並べておけば、あるリージョンのファイルが届いていないときに
-- 「見つからない」で落ちる ―― 黙って 0 件で通るより読み取りやすい。
-- ---------------------------------------------------------------------
WHILE i < ARRAY_LENGTH(kinds) DO
  SET kind = kinds[OFFSET(i)];
  SET table_fqn = FORMAT('%s.%s.%s',
    work_project_id, work_dataset,
    CONCAT(table_name_prefix, system_name, '_', 't_', 'meta_', kind, table_name_suffix));

  -- ['gs://…/asia-southeast1/views-*.avro', …] を組み立てる。
  -- **バケットは送り元ごとに引く。** 既定は送り元のバケットを直に読む形
  -- （送り元ごとに別のバケット）。拠点へコピーしてから読む形なら全部が
  -- 同じ拠点側バケットを指す。どちらでもここは変わらない。
  -- %T が配列を SQL のリテラルにしてくれるので、引用符の面倒を見なくてよい。
  SET uris_literal = FORMAT('%T', ARRAY(
    SELECT FORMAT('%s/%s/%s-*.avro', s.gcs_prefix, s.source_region, kind)
    FROM UNNEST(sources) AS s
    ORDER BY s.source_region));

  EXECUTE IMMEDIATE FORMAT(
    "LOAD DATA OVERWRITE `%s` FROM FILES (format = 'AVRO', uris = %s)",
    table_fqn, uris_literal);

  IF kind = 'manifest' THEN SET manifest_fqn = table_fqn; END IF;
  SET i = i + 1;
END WHILE;


-- ---------------------------------------------------------------------
-- 届いたものを確かめる
--
-- 書き出しは別リージョンの別スケジュールなので、**その途中を読むことが
-- ありうる。** 書き出しは 6 本の EXPORT を順に流すので、views は新しいのに
-- table_opts はまだ前回、という瞬間が実際に存在する。マニフェストを
-- いちばん最後に書いてあるのはそのためで、下の 3 つはその瞬間を掴んだか
-- どうかを見ている。
--
-- **静かに欠けたまま解析されるのがいちばん困る。** build_table.sql より前に
-- 落ちれば、レポートには前の日のカードが残ったままになる（欠けたカードで
-- 上書きされない）。
-- ---------------------------------------------------------------------
-- (1) 並べた送り元がマニフェストに全部あるか
EXECUTE IMMEDIATE FORMAT("""
SELECT ARRAY(
  SELECT r FROM UNNEST(%T) AS r
  WHERE r NOT IN (SELECT source_region FROM `%s`))
""", source_regions, manifest_fqn) INTO missing_regions;
ASSERT ARRAY_LENGTH(missing_regions) = 0 AS
  'マニフェストに無い送り元があります。そのリージョンの書き出しか GCS のコピーが終わっていません。';

-- (2) 古すぎないか
--
-- collected_at_iso は STRING で運んでいる。TIMESTAMP のまま avro にすると
-- 論理型として書かれ、use_avro_logical_types を付けないと INT64 で戻る ――
-- 落ちずに比較だけが狂うので、書き出し側で文字列にしてある。
EXECUTE IMMEDIATE FORMAT("""
SELECT ARRAY(
  SELECT DISTINCT source_region FROM `%s`
  WHERE PARSE_TIMESTAMP('%%Y-%%m-%%dT%%H:%%M:%%SZ', collected_at_iso)
        < TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL %d HOUR))
""", manifest_fqn, max_staleness_hours) INTO stale_regions;
ASSERT ARRAY_LENGTH(stale_regions) = 0 AS
  '取り込んだメタデータが古すぎます。送り元の書き出しか GCS のコピーが止まっています（max_staleness_hours を確認）。';

-- (3) 行数がマニフェストと合うか
--
-- 書き出した側が数えた件数と、いま読み込んだ行数を突き合わせる。
-- 書き出しの途中を掴んだ、古い世代の avro が混ざっている、といった壊れ方は
-- ここで出る。**完全ではない**（同じ件数で中身だけ古い、という壊れ方は
-- (2) の側で拾う）が、静かに欠けるのはほぼ防げる。
--
-- マニフェストは縦持ち（1 種類 1 行）なので、そのまま kind で JOIN できる。
--
-- **FULL OUTER JOIN。** 内部結合にすると、ある種類が丸ごと空だったとき
-- 実測側に行が立たず、突き合わせる相手が消えて**素通りする**。いちばん
-- 防ぎたい壊れ方がそれなので、片側しか無い組も残して 0 として比べる。
EXECUTE IMMEDIATE FORMAT("""
SELECT STRING_AGG(msg, ' / ') FROM (
  SELECT FORMAT('%%s: %%s は %%d 行のはずが %%d 行',
                COALESCE(m.source_region, t.source_region),
                COALESCE(m.kind, t.kind),
                COALESCE(m.n_rows, 0), COALESCE(t.actual, 0)) AS msg
  FROM `%s` AS m
  FULL OUTER JOIN (
    SELECT source_region, 'schemata'    AS kind, COUNT(*) AS actual FROM `%s` GROUP BY source_region
    UNION ALL SELECT source_region, 'views',       COUNT(*) FROM `%s` GROUP BY source_region
    UNION ALL SELECT source_region, 'columns',     COUNT(*) FROM `%s` GROUP BY source_region
    UNION ALL SELECT source_region, 'field_paths', COUNT(*) FROM `%s` GROUP BY source_region
    UNION ALL SELECT source_region, 'table_opts',  COUNT(*) FROM `%s` GROUP BY source_region
  ) AS t
  ON m.source_region = t.source_region AND m.kind = t.kind
  WHERE COALESCE(m.n_rows, 0) != COALESCE(t.actual, 0)
)
""",
  manifest_fqn,
  FORMAT('%s.%s.%s', work_project_id, work_dataset, CONCAT(table_name_prefix, system_name, '_', 't_', 'meta_schemata',    table_name_suffix)),
  FORMAT('%s.%s.%s', work_project_id, work_dataset, CONCAT(table_name_prefix, system_name, '_', 't_', 'meta_views',       table_name_suffix)),
  FORMAT('%s.%s.%s', work_project_id, work_dataset, CONCAT(table_name_prefix, system_name, '_', 't_', 'meta_columns',     table_name_suffix)),
  FORMAT('%s.%s.%s', work_project_id, work_dataset, CONCAT(table_name_prefix, system_name, '_', 't_', 'meta_field_paths', table_name_suffix)),
  FORMAT('%s.%s.%s', work_project_id, work_dataset, CONCAT(table_name_prefix, system_name, '_', 't_', 'meta_table_opts',  table_name_suffix))
) INTO count_mismatch;
ASSERT count_mismatch IS NULL AS
  '取り込んだ行数がマニフェストと合いません。GCS のコピーが途中か、古い世代の avro が混ざっています。';

END;
