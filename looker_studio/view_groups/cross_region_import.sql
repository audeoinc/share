-- =====================================================================
-- 別リージョンの View メタデータを GCS から取り込む（拠点で流す）
--
-- ※ このファイルを直接編集する。生成物ではない。
--    設定は CONFIGURATION の DECLARE だけ。ほかに設定を置く場所はない。
--
-- cross_region_export.sql が書き出し、GCS → GCS のコピーで拠点側の
-- バケットへ渡ってきた avro を、拠点のデータセットにテーブルとして落とす。
-- 落とした 5 本を build_table.sql が拠点自身の INFORMATION_SCHEMA と
-- UNION ALL して解析する。
--
--   asia-southeast1                     asia-northeast1（拠点）
--   ┌──────────────────┐               ┌────────────────────────┐
--   │ INFORMATION_SCHEMA│               │ INFORMATION_SCHEMA      │
--   │        ↓ export   │               │            ＋            │
--   │ gs://…-se1/…      │ ── コピー ──→ │ gs://…-ne1/…            │
--   └──────────────────┘  （GCS → GCS）  │            ↓ このファイル │
--                                        │ viewlgc_imp_*（5 本）    │
--                                        │            ↓            │
--                                        │ build_table.sql         │
--                                        └────────────────────────┘
--
-- **バケットは書き出し側と別。** BigQuery は GCS との間で同じロケーションを
-- 要求し、asia-northeast1 と asia-southeast1 を組にしたデュアルリージョンは
-- 無いので、1 つのバケットで両方は兼ねられない（詳しくは
-- cross_region_export.sql の頭）。
--
-- LOAD DATA OVERWRITE はテーブルが無ければ作り、あれば中身とスキーマごと
-- 差し替える。**1 文で差し替わるので、読み手から見て「空のテーブル」が
-- 見える瞬間が無い。** build_table.sql が同じ理由で
-- CREATE OR REPLACE TABLE ... AS SELECT を使っているのと同じ考え方。
--
-- 実行順序: 書き出し → GCS コピー → **このファイル** → build_table.sql。
-- スケジュールドクエリにするなら、build_table.sql より前に置く。
--
-- **GCS のコピーは「宛先にしか無いファイルを消す」設定にすること。**
-- EXPORT DATA は書き出す側のバケットで同じ名前のファイルを消してから
-- 書くが、宛先のバケットは消してくれない。前回 2 分割で書かれ、今回
-- 1 つで足りたとき、宛先には前回の 2 つ目が残る。ワイルドカードで読むので
-- 古い行が混ざり、下の件数の突き合わせが毎回落ちることになる。
-- Storage Transfer Service なら「転送元にないオブジェクトを転送先から削除」
-- を有効にする。
-- =====================================================================
SET @@location = 'asia-northeast1';

BEGIN
-- ---------------------------------------------------------------------
-- CONFIGURATION（書き換えるのはここだけ）
-- ---------------------------------------------------------------------
-- [A] 環境ごとに必ず見るもの ------------------------------------------
-- 読み込み元。**拠点と同じロケーションのバケット**を指すこと。
-- 末尾に / は付けない。
DECLARE gcs_import_prefix STRING DEFAULT 'gs://CHANGE-ME-ne1/viewlgc';

-- 取り込む送り元リージョン。cross_region_export.sql を流したリージョンを
-- 並べる。**拠点自身（asia-northeast1）は入れない**（運ぶ必要が無く、
-- 入れると同じ行が 2 回入る）。増やすときはここに 1 つ足すだけ。
DECLARE source_regions ARRAY<STRING> DEFAULT ['asia-southeast1'];

-- 取り込んだメタデータの古さの上限（時間）。書き出しからこれ以上経って
-- いたら落とす。**運んだ側が止まっているのに、拠点だけ動き続けて
-- 「昨日のメタデータで解析した結果」を今日の顔で出すのを防ぐ。**
-- 日次で回すなら 36 時間くらい（1 日ぶんの遅れは許し、2 日は許さない）。
DECLARE max_staleness_hours INT64 DEFAULT 36;

-- このシステムを表す名前。すべてのオブジェクト名の先頭に入る。
-- **build_table.sql と同じ値にすること。**
DECLARE system_name STRING DEFAULT 'viewlgc';
-- 取り込み先のデータセット。build_table.sql の work_dataset と同じでよい。
DECLARE work_dataset STRING DEFAULT 'ops_meta';
-- テーブルの命名（prefix / suffix）。build_table.sql と同じ値にすること。
DECLARE table_name_prefix STRING DEFAULT '';
DECLARE table_name_suffix STRING DEFAULT '';

-- [C] 導出・内部用。編集しない ----------------------------------------
DECLARE job_region STRING DEFAULT @@location;
DECLARE default_project_id STRING;
DECLARE work_project_id    STRING DEFAULT NULL;  -- テーブルの置き場所

-- 取り込む 5 本 ＋ マニフェスト。名前は build_table.sql と同じ規則で組み立てる
-- （table_name_prefix || system_name || '_imp_' || 種類 || table_name_suffix）。
-- 種類の文字列は cross_region_export.sql のファイル名と 1 対 1。
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

ASSERT NOT STARTS_WITH(gcs_import_prefix, 'gs://CHANGE-ME') AS
  'gcs_import_prefix を書き換えてください（拠点と同じロケーションのバケットを指すこと）。';
ASSERT STARTS_WITH(gcs_import_prefix, 'gs://') AND NOT ENDS_WITH(gcs_import_prefix, '/') AS
  'gcs_import_prefix は gs:// で始まり、末尾に / を付けない形にしてください。';
ASSERT ARRAY_LENGTH(source_regions) > 0 AS
  'source_regions が空です。運んでくるリージョンを 1 つ以上並べてください。';
ASSERT job_region NOT IN UNNEST(source_regions) AS
  '拠点自身のリージョンが source_regions に入っています。拠点のぶんは build_table.sql が直接読むので、ここに入れると同じ行が 2 回入ります。';


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
    CONCAT(table_name_prefix, system_name, '_imp_', kind, table_name_suffix));

  -- ['gs://…/asia-southeast1/views-*.avro', …] を組み立てる。
  -- %T が配列を SQL のリテラルにしてくれるので、引用符の面倒を見なくてよい。
  SET uris_literal = FORMAT('%T', ARRAY(
    SELECT FORMAT('%s/%s/%s-*.avro', gcs_import_prefix, r, kind)
    FROM UNNEST(source_regions) AS r
    ORDER BY r));

  EXECUTE IMMEDIATE FORMAT(
    "LOAD DATA OVERWRITE `%s` FROM FILES (format = 'AVRO', uris = %s)",
    table_fqn, uris_literal);

  IF kind = 'manifest' THEN SET manifest_fqn = table_fqn; END IF;
  SET i = i + 1;
END WHILE;


-- ---------------------------------------------------------------------
-- 届いたものを確かめる
--
-- GCS → GCS のコピーは順序を約束しないので、拠点側が「コピーの途中」を
-- 読むことがありうる。**静かに欠けたまま解析されるのがいちばん困る**ので、
-- 3 つ確かめてから通す。build_table.sql より前に落ちれば、レポートには
-- 前の日のカードが残ったままになる（欠けたカードで上書きされない）。
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
  SELECT source_region FROM `%s`
  WHERE PARSE_TIMESTAMP('%%Y-%%m-%%dT%%H:%%M:%%SZ', collected_at_iso)
        < TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL %d HOUR))
""", manifest_fqn, max_staleness_hours) INTO stale_regions;
ASSERT ARRAY_LENGTH(stale_regions) = 0 AS
  '取り込んだメタデータが古すぎます。送り元の書き出しか GCS のコピーが止まっています（max_staleness_hours を確認）。';

-- (3) 行数がマニフェストと合うか
--
-- 書き出した側が数えた件数と、いま読み込んだ行数を突き合わせる。
-- ファイルが途中までしかコピーされていない、古い世代の avro が混ざって
-- いる、といった壊れ方はここで出る。**完全ではない**（同じ件数で中身だけ
-- 古い、という壊れ方は (2) の側で拾う）が、静かに欠けるのはほぼ防げる。
--
-- **FULL OUTER JOIN。** 内部結合にすると、ある種類が丸ごと空だったとき
-- 実測側に行が立たず、突き合わせる相手が消えて**素通りする**。いちばん
-- 防ぎたい壊れ方がそれなので、片側しか無い組も残して 0 として比べる。
EXECUTE IMMEDIATE FORMAT("""
SELECT STRING_AGG(msg, ' / ') FROM (
  SELECT FORMAT('%%s: %%s は %%d 行のはずが %%d 行',
                COALESCE(m.source_region, t.source_region),
                COALESCE(m.kind, t.kind),
                COALESCE(m.expected, 0), COALESCE(t.actual, 0)) AS msg
  FROM (
    SELECT source_region, 'schemata'    AS kind, n_schemata    AS expected FROM `%s`
    UNION ALL SELECT source_region, 'views',       n_views       FROM `%s`
    UNION ALL SELECT source_region, 'columns',     n_columns     FROM `%s`
    UNION ALL SELECT source_region, 'field_paths', n_field_paths FROM `%s`
    UNION ALL SELECT source_region, 'table_opts',  n_table_opts  FROM `%s`
  ) AS m
  FULL OUTER JOIN (
    SELECT source_region, 'schemata'    AS kind, COUNT(*) AS actual FROM `%s` GROUP BY source_region
    UNION ALL SELECT source_region, 'views',       COUNT(*) FROM `%s` GROUP BY source_region
    UNION ALL SELECT source_region, 'columns',     COUNT(*) FROM `%s` GROUP BY source_region
    UNION ALL SELECT source_region, 'field_paths', COUNT(*) FROM `%s` GROUP BY source_region
    UNION ALL SELECT source_region, 'table_opts',  COUNT(*) FROM `%s` GROUP BY source_region
  ) AS t
  ON m.source_region = t.source_region AND m.kind = t.kind
  WHERE COALESCE(m.expected, 0) != COALESCE(t.actual, 0)
)
""",
  manifest_fqn, manifest_fqn, manifest_fqn, manifest_fqn, manifest_fqn,
  FORMAT('%s.%s.%s', work_project_id, work_dataset, CONCAT(table_name_prefix, system_name, '_imp_schemata',    table_name_suffix)),
  FORMAT('%s.%s.%s', work_project_id, work_dataset, CONCAT(table_name_prefix, system_name, '_imp_views',       table_name_suffix)),
  FORMAT('%s.%s.%s', work_project_id, work_dataset, CONCAT(table_name_prefix, system_name, '_imp_columns',     table_name_suffix)),
  FORMAT('%s.%s.%s', work_project_id, work_dataset, CONCAT(table_name_prefix, system_name, '_imp_field_paths', table_name_suffix)),
  FORMAT('%s.%s.%s', work_project_id, work_dataset, CONCAT(table_name_prefix, system_name, '_imp_table_opts',  table_name_suffix))
) INTO count_mismatch;
ASSERT count_mismatch IS NULL AS
  '取り込んだ行数がマニフェストと合いません。GCS のコピーが途中か、古い世代の avro が混ざっています。';

END;
