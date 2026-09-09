-- ============================================================================
-- 01_setup_cost_environment.sql
-- BigQuery Query Cost Repository - environment setup (idempotent)
-- ============================================================================
-- 実行 SQL のコストを Looker Studio で確認するためのリポジトリを作成する。
--
-- ★ このスクリプトは破壊的です。表は CREATE OR REPLACE で作り直すため、
--    流し直すと bqc_t_job_cost / bqc_t_daily_cost / bqc_m_query_fingerprint の
--    中身は消えます。スキーマ変更を確実に反映させるための意図的な挙動です。
--    流したあとは必ず 02 → 03 の順で流し直してください（02 は表が空なら
--    initial_lookback_days 分を自動でバックフィルするので、元の状態に戻せます）。
--    データの正本は INFORMATION_SCHEMA.JOBS 側なので、保持期間内であれば
--    ここを消しても失われるものはありません。
--
-- 前提: データセット（repository_dataset / udf_dataset）は事前に作成されていること。
--       インフラチームへの作成依頼が必要な運用のため、このスクリプトは作りません。
--       存在しない場合はエラーで停止します。
--
-- 作成物:
--
--   UDF   bqc_normalize_sql          … SQL からリテラル/コメントを除去した正規化文字列
--   表    bqc_t_job_cost             … job 粒度のコスト実績（親 SCRIPT と子文の両方）
--   VIEW  bqc_vw_t_job_cost_resolved … 上に親子関係の解決列を足したもの。集計はこちらを使う
--   表    bqc_t_daily_cost           … 日 × fingerprint × 実行者 の集約（Looker が読む実体）
--   表    bqc_m_query_fingerprint    … fingerprint 次元（first_seen / プレビュー）
--   VIEW  bqc_vw_t_daily_cost_report … レポート定義の正本
--
-- Looker Studio が読むのはこのビューではなく、03 が毎回焼き直す静的テーブル
-- bqc_t_daily_cost_report です（ビューのままだと開くたびに集約と JOIN が走るため）。
-- そちらは 03 の CREATE OR REPLACE TABLE が作るので、01 では作成しません。
--
-- 対象期間は INFORMATION_SCHEMA.JOBS が持っている範囲（最大 180 日）だけ。
-- それより古い履歴を積み増して保持することは目的にしていないので、03 が保持期間を
-- 超えた行を刈り取る（retention_days、既定 180 日）。JOBS 自身が既に捨てた分しか
-- 消さないため、元データから作り直せる範囲は失われない。
--
-- 実行順:  01（初回のみ） → 02（日次） → 03（日次、02 の後）
--
-- Not yet validated against BigQuery.
-- ============================================================================
SET @@location = 'asia-northeast1';

BEGIN
  -- --------------------------------------------------------------------------
  -- [A] REQUIRED per deployment / region -- set these
  -- --------------------------------------------------------------------------
  -- GCP project: 実行時に自動取得する。その DECLARE は [B] にある
  -- （別プロジェクトに作る場合のみ [C] の SET をリテラルに置き換える）。
  -- Project-token substitution
  DECLARE project_token_pattern STRING DEFAULT r'^([^-]+)';
  -- Datasets (repository / UDF)
  DECLARE repository_dataset STRING DEFAULT 'bq_cost_repository';
  DECLARE udf_dataset STRING DEFAULT 'bq_cost_repository';
  -- Table / view naming
  DECLARE table_name_prefix STRING DEFAULT '';
  DECLARE table_name_suffix STRING DEFAULT '';
  -- UDF naming (ルーチン名にハイフンは使えないので表とは別ノブにする)
  DECLARE udf_name_prefix STRING DEFAULT '';
  DECLARE udf_name_suffix STRING DEFAULT '';
  --
  -- Variable notes (keyed by name):
  --   project_token_pattern
  --     自動取得した project id から token を抜く正規表現（group 1）。データセット名と
  --     prefix/suffix 中の '{project_token}' を実行時に置換する。既定は先頭ハイフン区切り。
  --   repository_dataset
  --     表・ビューを置くデータセット。事前に作成されている必要がある
  --     （このスクリプトは作らず、無ければエラーで停止する）。
  --   udf_dataset
  --     UDF を置くデータセット。既定は repository_dataset と同じだが、UDF だけ
  --     共有データセットに集約している運用もあるため独立したノブにしてある。
  --     こちらも事前に作成されている必要がある。
  --     別データセットにする場合は 02 の udf_dataset も同じ値に揃えること
  --     （02 はここで作った UDF を名前で呼ぶだけなので、食い違うと Not found になる）。
  --   table_name_prefix / table_name_suffix
  --     表・ビュー名の可変部。02/03 と必ず同じ値にすること。
  --   udf_name_prefix / udf_name_suffix
  --     UDF 名の可変部。02 が呼ぶ UDF 名と揃えること。

  -- --------------------------------------------------------------------------
  -- [B] BEHAVIOR OPTIONS -- defaults are safe; tune as needed
  -- --------------------------------------------------------------------------
  -- GCP project。通常は手で設定しない（[C] で自動取得）。
  DECLARE default_project_id STRING;
  -- バッククォート識別子（テーブル名など）を ? でマスクするか。
  --   FALSE（既定）: バッククォートだけ外して中身を残す。`p.d.orders` と
  --                  `p.d.tiny_master` が別 fingerprint になり、「どの SQL が高いか」
  --                  「新しくコストを出した SQL はどれか」が正しく効く。
  --   TRUE        : テーブル名まで ? に潰す。PII がテーブル名/列名に入りうる環境向け。
  --                 ただし別テーブルへの同型クエリが 1 つに融合する点に注意。
  -- ※ 切り替えたら fingerprint 空間が変わる。必ず normalizer_version も上げ、
  --    過去データと混ぜないこと。
  DECLARE mask_backtick_identifiers BOOL DEFAULT FALSE;
  -- 正規化ロジックのバージョン。UDF 本体を変えたら必ず上げる。
  -- fingerprint は正規化結果のハッシュなので、ロジックが変わると同じ SQL でも
  -- 別 fingerprint になる。この列があれば「いつロジックを変えたか」で説明できる。
  DECLARE normalizer_version STRING DEFAULT 'v1';

  -- --------------------------------------------------------------------------
  -- [C] DERIVED / INTERNAL -- from [A]; DO NOT edit
  -- --------------------------------------------------------------------------
  DECLARE repository_project_id STRING DEFAULT NULL;
  -- UDF の置き場所。別プロジェクトに置く場合だけリテラルを入れる。
  DECLARE udf_project_id STRING DEFAULT NULL;
  DECLARE project_token STRING;
  DECLARE dataset_fqn STRING;
  DECLARE udf_dataset_fqn STRING;
  DECLARE normalize_udf_fqn STRING;
  DECLARE job_cost_fqn STRING;
  DECLARE job_cost_resolved_fqn STRING;
  DECLARE daily_cost_fqn STRING;
  DECLARE query_dim_fqn STRING;
  DECLARE report_view_fqn STRING;
  DECLARE normalize_udf_name STRING;
  DECLARE job_cost_name STRING;
  DECLARE job_cost_resolved_name STRING;
  DECLARE daily_cost_name STRING;
  DECLARE query_dim_name STRING;
  DECLARE report_view_name STRING;
  DECLARE backtick_replacement STRING;
  DECLARE smoke_test_result STRING;
  DECLARE dataset_exists_count INT64;

  -- 実行プロジェクトの自動取得（catalog_name = ジョブ実行プロジェクト）。
  -- DECLARE-DEFAULT の評価順の都合で、全 DECLARE の後の最初の実行文に置く。
  EXECUTE IMMEDIATE FORMAT(
    "SELECT DISTINCT catalog_name FROM `region-%s`.INFORMATION_SCHEMA.SCHEMATA LIMIT 1",
    @@location
  ) INTO default_project_id;
  ASSERT default_project_id IS NOT NULL AS
    'Could not auto-detect the project id from INFORMATION_SCHEMA.SCHEMATA; set default_project_id to a literal.';
  SET repository_project_id = COALESCE(repository_project_id, default_project_id);
  SET udf_project_id = COALESCE(udf_project_id, default_project_id);

  -- project token 置換（名前の組み立て・ASSERT より前に行う）
  SET project_token =
    COALESCE(REGEXP_EXTRACT(default_project_id, project_token_pattern), '');
  SET repository_dataset = REPLACE(repository_dataset, '{project_token}', project_token);
  SET udf_dataset = REPLACE(udf_dataset, '{project_token}', project_token);
  SET table_name_prefix = REPLACE(table_name_prefix, '{project_token}', project_token);
  SET table_name_suffix = REPLACE(table_name_suffix, '{project_token}', project_token);
  SET udf_name_prefix = REPLACE(udf_name_prefix, '{project_token}', project_token);
  SET udf_name_suffix = REPLACE(udf_name_suffix, '{project_token}', project_token);

  -- 早期 ASSERT: 残留 '{project_token}' や不正文字を DDL 実行前に検出する
  ASSERT REGEXP_CONTAINS(repository_dataset, r'^[A-Za-z0-9_]+$')
  AS 'repository_dataset must be letters/digits/underscore only (check for an unsubstituted {project_token}).';
  ASSERT REGEXP_CONTAINS(udf_dataset, r'^[A-Za-z0-9_]+$')
  AS 'udf_dataset must be letters/digits/underscore only (check for an unsubstituted {project_token}).';

  SET normalize_udf_name = udf_name_prefix || 'bqc_' || 'normalize_sql' || udf_name_suffix;
  SET job_cost_name  = table_name_prefix || 'bqc_' || 't_'  || 'job_cost'          || table_name_suffix;
  SET job_cost_resolved_name =
    table_name_prefix || 'bqc_' || 'vw_t_' || 'job_cost_resolved' || table_name_suffix;
  SET daily_cost_name = table_name_prefix || 'bqc_' || 't_' || 'daily_cost'        || table_name_suffix;
  SET query_dim_name = table_name_prefix || 'bqc_' || 'm_'  || 'query_fingerprint' || table_name_suffix;
  SET report_view_name =
    table_name_prefix || 'bqc_' || 'vw_t_' || 'daily_cost_report' || table_name_suffix;

  ASSERT REGEXP_CONTAINS(normalize_udf_name, r'^[A-Za-z0-9_]+$')
  AS 'Invalid normalize_udf_name (routine names cannot contain hyphens).';

  SET dataset_fqn       = FORMAT('%s.%s', repository_project_id, repository_dataset);
  SET udf_dataset_fqn   = FORMAT('%s.%s', udf_project_id, udf_dataset);
  SET normalize_udf_fqn = FORMAT('%s.%s', udf_dataset_fqn, normalize_udf_name);
  SET job_cost_fqn      = FORMAT('%s.%s', dataset_fqn, job_cost_name);
  SET job_cost_resolved_fqn = FORMAT('%s.%s', dataset_fqn, job_cost_resolved_name);
  SET daily_cost_fqn    = FORMAT('%s.%s', dataset_fqn, daily_cost_name);
  SET query_dim_fqn     = FORMAT('%s.%s', dataset_fqn, query_dim_name);
  SET report_view_fqn   = FORMAT('%s.%s', dataset_fqn, report_view_name);

  -- --------------------------------------------------------------------------
  -- STEP 1: dataset の存在確認（作成はしない）
  -- --------------------------------------------------------------------------
  -- データセットはインフラチームが作成する運用なので、このスクリプトでは作らない。
  -- 存在しなければここで止める。
  --
  -- 黙って作ってしまう（CREATE SCHEMA IF NOT EXISTS）と、[A] の dataset 名を
  -- 打ち間違えたときに想定外の場所へ一式ができあがり、しかもエラーにならないため
  -- 気づけない。作成依頼が必要な運用なら、なおさら「無い」ことは失敗にする。
  --
  -- 判定はリージョン修飾の SCHEMATA で行う。別リージョンに同名のデータセットが
  -- あっても、この @@location からは使えないので「無い」と扱うのが正しい。
  EXECUTE IMMEDIATE FORMAT(
    """SELECT COUNT(*) FROM `%s.region-%s`.INFORMATION_SCHEMA.SCHEMATA
       WHERE schema_name = '%s'""",
    repository_project_id, @@location, repository_dataset
  ) INTO dataset_exists_count;

  IF dataset_exists_count = 0 THEN
    -- ASSERT の説明文は文字列リテラルしか受け付けないので、名前を含む案内を
    -- 出すために RAISE を使う。
    RAISE USING MESSAGE = FORMAT(
      'Repository dataset `%s` does not exist in region %s. This script does not create datasets -- ask the infrastructure team to create it first.',
      dataset_fqn, @@location
    );
  END IF;

  -- UDF 用データセットも同様に確認する（表と別プロジェクト/別データセットを
  -- 指定できるため、同じ値のときも含めて改めて引く）。
  EXECUTE IMMEDIATE FORMAT(
    """SELECT COUNT(*) FROM `%s.region-%s`.INFORMATION_SCHEMA.SCHEMATA
       WHERE schema_name = '%s'""",
    udf_project_id, @@location, udf_dataset
  ) INTO dataset_exists_count;

  IF dataset_exists_count = 0 THEN
    RAISE USING MESSAGE = FORMAT(
      'UDF dataset `%s` does not exist in region %s. This script does not create datasets -- ask the infrastructure team to create it first.',
      udf_dataset_fqn, @@location
    );
  END IF;

  -- --------------------------------------------------------------------------
  -- STEP 2: normalization UDF
  -- --------------------------------------------------------------------------
  -- SQL からコメントと文字列/数値リテラルを取り除いた「正規化文字列」を返す。
  -- fingerprint はこの結果を UPPER() したものの MD5 なので、この関数を変えると
  -- fingerprint 空間が変わる。変更時は必ず normalizer_version を上げること。
  --
  -- 実装はリテラル置換の REGEXP_REPLACE を内側から順に重ねたもの。適用順に意味が
  -- あるので並べ替えないこと（tools/normalize_reference.py と 1:1 対応。どちらかを
  -- 直したら両方直す。あちらは同じ RE2 エンジンでの自己テスト付き）。
  --
  -- 設計上の前提と限界:
  --   * BigQuery の正規表現は RE2 なので先読み/後読み (?=) (?<=) が使えない。
  --     数値リテラルは直前 1 文字を捕獲して書き戻すことで identifier 内の数字
  --     （col1 / t1.x / analytics_123456789）を守っている。
  --   * コメントを文字列より先に除去する。文字列中の -- より、コメント中の
  --     アポストロフィのほうが圧倒的に多いため。逆順にすると
  --     「-- don't scan」で正規化が崩れる。文字列中に -- を含む稀なクエリでは
  --     fingerprint が本来より粗くなるが、コスト額の集計には影響しない。
  --   * 字句解析ではないので完全ではない。より厳密にしたい場合は lineage の
  --     lnge_fingerprint_sql（Lexer ベースの JS UDF）に差し替えられる。その場合も
  --     normalizer_version を上げること。
  SET backtick_replacement = IF(mask_backtick_identifiers, "'?'", r"r'\1'");

  EXECUTE IMMEDIATE FORMAT(r"""
    CREATE OR REPLACE FUNCTION `%s`(sql_text STRING)
    RETURNS STRING
    OPTIONS(description = 'Normalize a SQL string for cost fingerprinting: strip comments, replace string/number literals with ?, collapse date-sharded table suffixes and repeated placeholders.')
    AS (
      TRIM(
        REGEXP_REPLACE(                        -- 7. 空白の正規化
        REGEXP_REPLACE(                        -- 6. 連続プレースホルダの畳み込み
        REGEXP_REPLACE(                        -- 5b. 数値リテラル
        REGEXP_REPLACE(                        -- 5a. 16進リテラル
        REGEXP_REPLACE(                        -- 4b. _YYYYMM シャード
        REGEXP_REPLACE(                        -- 4a. _YYYYMMDD シャード
        REGEXP_REPLACE(                        -- 3.  バッククォート識別子
        REGEXP_REPLACE(                        -- 2d. '...' 文字列
        REGEXP_REPLACE(                        -- 2c. "..." 文字列
        REGEXP_REPLACE(                        -- 2b. 三重引用符 (single)
        REGEXP_REPLACE(                        -- 2a. 三重引用符 (double)
        REGEXP_REPLACE(                        -- 1c. # コメント
        REGEXP_REPLACE(                        -- 1b. -- コメント
        REGEXP_REPLACE(                        -- 1a. ブロックコメント
          sql_text,
          r'(?s)/\*.*?\*/', ' '),
          r'--[^\n]*', ' '),
          r'#[^\n]*', ' '),
          r'(?s)[rRbB]{0,2}["]["]["].*?["]["]["]', '?'),
          r"(?s)[rRbB]{0,2}['][']['].*?[']['][']", '?'),
          r'[rRbB]{0,2}["](?:[^"\\]|\\.)*["]', '?'),
          r"[rRbB]{0,2}['](?:[^'\\]|\\.)*[']", '?'),
          r'`([^`]*)`', %s),
          r'_[0-9]{8}\b', '_?'),
          r'_[0-9]{6}\b', '_?'),
          r'([^A-Za-z0-9_.$])0[xX][0-9A-Fa-f]+', r'\1?'),
          r'([^A-Za-z0-9_.$])[-+]?[0-9]+(?:\.[0-9]+)?(?:[eE][-+]?[0-9]+)?', r'\1?'),
          r'\?(?:\s*,\s*\?)+', '?'),
          r'\s+', ' ')
      )
    )
  """, normalize_udf_fqn, backtick_replacement);

  -- スモークテスト。UDF が壊れた状態で表を作っても意味がないのでここで止める。
  -- 1回の入力でコメント除去・バッククォート除去・日付シャード畳み込み・文字列
  -- リテラル・IN リスト畳み込みの5つを同時に検証する。
  -- （mask_backtick_identifiers = TRUE のときは期待値が変わるので、その場合は
  --   期待値側の 'p.d.events_?' を '?' に読み替えて ASSERT を調整すること）
  EXECUTE IMMEDIATE FORMAT(
    r"""SELECT `%s`("/* ctx: run=7 */ SELECT COUNT(*) FROM `p.d.events_20260101` WHERE s = 'x' AND n IN (1, 2, 3)")""",
    normalize_udf_fqn
  ) INTO smoke_test_result;

  ASSERT smoke_test_result =
    'SELECT COUNT(*) FROM p.d.events_? WHERE s = ? AND n IN (?)'
  AS 'bqc_normalize_sql smoke test failed -- the normalization chain did not produce the expected canonical form.';

  -- --------------------------------------------------------------------------
  -- STEP 3: bqc_t_job_cost -- job 粒度のコスト実績
  -- --------------------------------------------------------------------------
  -- 1 行 = 1 ジョブ。親 SCRIPT と子文の両方が入る（親子の切り分けは STEP 4 の
  -- 解決ビューが担当）。02 が MERGE で (job_region, project_id, job_id) 一意に投入する。
  -- CREATE OR REPLACE なので、ここを流すと既存の取り込み結果は消える。
  EXECUTE IMMEDIATE FORMAT(r"""
    CREATE OR REPLACE TABLE `%s` (
      job_region              STRING    OPTIONS(description = 'JOBS を読んだリージョン (例: asia-northeast1)'),
      project_id              STRING    OPTIONS(description = 'ジョブを実行したプロジェクト'),
      job_id                  STRING    OPTIONS(description = 'ジョブID。(job_region, project_id, job_id) で一意'),
      parent_job_id           STRING    OPTIONS(description = '親 SCRIPT ジョブのID。単独ジョブは NULL'),
      creation_time           TIMESTAMP OPTIONS(description = 'ジョブ作成時刻 (UTC)'),
      creation_date           DATE      OPTIONS(description = 'creation_time の日付 (UTC)。パーティションキー'),
      start_time              TIMESTAMP OPTIONS(description = 'ジョブ開始時刻 (UTC)'),
      end_time                TIMESTAMP OPTIONS(description = 'ジョブ終了時刻 (UTC)'),
      elapsed_ms              INT64     OPTIONS(description = '経過時間(ms)。スロット時間ではない'),
      user_email              STRING    OPTIONS(description = '実行アカウント (人またはサービスアカウント)'),
      subsystem_id            STRING    OPTIONS(description = 'labels の subsystemid の値。未設定なら NULL'),
      executor_id             STRING    OPTIONS(description = '実行者の識別子。subsystem_id、無ければ user_email'),
      executor_source         STRING    OPTIONS(description = 'executor_id の出所: LABEL / USER_EMAIL。LABEL 比率がラベル付与のカバレッジになる'),
      job_type                STRING    OPTIONS(description = 'ジョブ種別 (QUERY 等)'),
      statement_type          STRING    OPTIONS(description = 'SELECT / CREATE_TABLE_AS_SELECT / SCRIPT 等。SCRIPT は子文の集計行なので、集計時は解決ビューの is_cost_countable で除く'),
      cache_hit               BOOL      OPTIONS(description = 'キャッシュヒット。TRUE なら total_bytes_billed は 0 で課金なし'),
      is_error                BOOL      OPTIONS(description = 'error_result が入っていたか。リトライ嵐の検出に使う'),
      error_reason            STRING    OPTIONS(description = 'error_result.reason'),
      reservation_id          STRING    OPTIONS(description = '使用した予約。NULL ならオンデマンド'),
      pricing_model           STRING    OPTIONS(description = 'ON_DEMAND / CAPACITY。どちらの指標が課金かを決める切り分け列'),
      total_bytes_processed   INT64     OPTIONS(description = 'スキャンしたバイト数'),
      total_bytes_billed      INT64     OPTIONS(description = '課金対象バイト数。オンデマンド課金の基礎'),
      tib_billed              FLOAT64   OPTIONS(description = 'total_bytes_billed を TiB にしたもの。単価を掛ければ金額になる'),
      total_slot_ms           INT64     OPTIONS(description = '消費スロット時間(ms)。キャパシティ課金の基礎'),
      slot_hours              FLOAT64   OPTIONS(description = 'total_slot_ms をスロット時間にしたもの。経過時間ではない'),
      referenced_table_count  INT64     OPTIONS(description = '参照テーブル数'),
      referenced_tables_text  STRING    OPTIONS(description = '参照テーブルを改行区切りで連結したもの。Looker Studio は ARRAY を読めないため文字列で持つ'),
      query                   STRING    OPTIONS(description = 'クエリ原文。PII を含みうる。不要になったらこの列だけ落とす'),
      raw_fingerprint         STRING    OPTIONS(description = 'query 原文の MD5。完全一致の識別子'),
      normalized_query        STRING    OPTIONS(description = 'リテラルとコメントを除去した正規化SQL。大小文字は原文どおり'),
      normalized_fingerprint  STRING    OPTIONS(description = 'UPPER(normalized_query) の MD5。SQL の形が同じなら同じ値'),
      normalized_fingerprint_t STRING   OPTIONS(description = '正規化SQL + 参照テーブル一覧 の MD5。形もテーブルも同じときだけ一致する'),
      normalized_preview      STRING    OPTIONS(description = '正規化SQLの先頭100文字'),
      normalized_from_preview STRING    OPTIONS(description = '正規化SQLの最初の FROM 以降100文字。先頭100文字だけだと SELECT 句で終わって識別できないため'),
      normalizer_version      STRING    OPTIONS(description = '正規化ロジックのバージョン。値が違う行の fingerprint は比較できない'),
      loaded_at               TIMESTAMP OPTIONS(description = 'この行を取り込んだ時刻')
    )
    PARTITION BY creation_date
    CLUSTER BY normalized_fingerprint, executor_id
    OPTIONS(description = 'BigQuery クエリコストの job 粒度実績。INFORMATION_SCHEMA.JOBS から 02 が日次で取り込み、03 が保持期間を超えた行を刈り取る。')
  """, job_cost_fqn);

  -- --------------------------------------------------------------------------
  -- STEP 4: bqc_vw_t_job_cost_resolved -- 親子関係を解決したビュー
  -- --------------------------------------------------------------------------
  -- 親子のセマンティクスはすべてここに集約する。02 は JOBS の行をそのまま入れる
  -- だけにして、判定はこのビューが担う。
  --
  -- なぜ 02 で判定しないか: 02 は 15 日ずつに分けて JOBS をスキャンするため、
  -- 親が前のチャンク・子が次のチャンクに落ちると、その時点では親子関係が見えない。
  -- 表全体が見えるビューで判定すれば、チャンクの切れ目に影響されない。
  --
  -- 実測で確認済み（2026-09、adhoc/08_inspect_job_hierarchy.sql）:
  --   * 親子は 1 段のみ。「子であり、かつ子を持つ」ジョブは 0 件。
  --     よって root_job_id = IFNULL(parent_job_id, job_id) で大元に到達できる。
  --   * 親 SCRIPT の total_bytes_billed / total_slot_ms は子の合計と一致する。
  --     つまり親は子の集計行であり、両方を足すと二重計上になる。
  EXECUTE IMMEDIATE FORMAT(r"""
    CREATE OR REPLACE VIEW `%s`
    OPTIONS(description = 'bqc_t_job_cost に親子関係の解決列を足したビュー。コストは root_* (作業単位) と statement_* (文単位) の2系統で持つ。どちらを合計しても総量は一致し、粒度だけが変わる。2つを足さないこと。')
    AS
    WITH parent_ids AS (
      -- 「子を持つか」は相関サブクエリではなく親IDの一覧との LEFT JOIN で判定する
      -- （BigQuery は CTE を参照する相関サブクエリを常に de-correlate できない）。
      SELECT DISTINCT job_region, project_id, parent_job_id AS job_id
      FROM `%s`
      WHERE parent_job_id IS NOT NULL
    ),
    existing_jobs AS (
      -- 親の行がこの表に実在するかを見るための ID 一覧。
      -- 親と子は数秒差で作られるが、取り込み窓の先頭や保持期間の刈り取りは
      -- 時刻の途中で切れるため、親だけが落ちて子が残る「孤児」が必ず端に生じる。
      SELECT DISTINCT job_region, project_id, job_id
      FROM `%s`
    ),
    flagged AS (
      SELECT
        j.*,
        j.parent_job_id IS NOT NULL AS is_child,
        p.job_id IS NOT NULL        AS has_child_jobs,
        e.job_id IS NOT NULL        AS has_parent_row,
        -- 孤児は自分自身を作業単位の代表にする。親IDのまま置くと、代表行が
        -- 存在しない作業単位ができて root 系の合計から丸ごと抜け落ちる。
        IF(e.job_id IS NOT NULL, j.parent_job_id, j.job_id) AS root_job_id
      FROM `%s` AS j
      LEFT JOIN parent_ids AS p
        ON  p.job_region = j.job_region
        AND p.project_id = j.project_id
        AND p.job_id     = j.job_id
      LEFT JOIN existing_jobs AS e
        ON  e.job_region = j.job_region
        AND e.project_id = j.project_id
        AND e.job_id     = j.parent_job_id
    ),
    classified AS (
      SELECT
        f.*,
        CASE
          WHEN has_child_jobs THEN 'PARENT'
          WHEN is_child       THEN 'CHILD'
          ELSE 'STANDALONE'
        END AS job_role,
        -- 子を持つ行は自分では計算していない集計行なので、コスト合計から外す。
        -- statement_type でも重ねて弾いているのは、子が保持期間の外に出るなどして
        -- 一時的に「子が見えない親」が生じても安全側に倒すため。
        NOT has_child_jobs AND IFNULL(statement_type, '') != 'SCRIPT'
          AS is_cost_countable,
        -- 作業単位の代表行か。「親の行がこの表に実在しない」で判定する。
        -- parent_job_id IS NULL だけで判定すると、孤児（親が刈り取られた子）が
        -- どの作業単位の代表にもならず、root 系の合計が静かに減る。
        NOT has_parent_row AS is_root_job,
        -- 親の中での実行順。スクリプトのどの文が重いかを見るための軸。
        -- 親自身・単独ジョブ・孤児は NULL（孤児は兄弟も欠けている可能性があり、
        -- 番号を振っても信用できないため）。
        CASE
          WHEN NOT has_parent_row THEN NULL
          ELSE ROW_NUMBER() OVER (
            PARTITION BY job_region, project_id, parent_job_id
            ORDER BY creation_time, start_time, job_id
          )
        END AS statement_index,
        -- この作業単位に属する子の本数（親行にも子行にも同じ値が入る）。
        -- has_parent_row で数えるので、孤児は自分を子として数えない。
        SUM(IF(has_parent_row, 1, 0)) OVER (
          PARTITION BY job_region, project_id, root_job_id
        ) AS root_statement_count
      FROM flagged AS f
    )
    SELECT
      -- 素のコスト列は意図的に外している。1 つの列で持つと、親と子を混ぜて
      -- 合計したときに黙って二重計上になるため。代わりに下の 2 系統を使う。
      -- 原本の値が要るときは bqc_t_job_cost を直接見ること。
      * EXCEPT(
        is_child,
        total_slot_ms, slot_hours,
        total_bytes_billed, tib_billed
      ),
      -- root 系: 作業単位（スクリプト1本／単独クエリ1本）としての消費。
      -- 値が入るのは PARENT と STANDALONE。CHILD は NULL。
      IF(is_root_job, total_slot_ms,      NULL) AS root_total_slot_ms,
      IF(is_root_job, slot_hours,         NULL) AS root_slot_hours,
      IF(is_root_job, total_bytes_billed, NULL) AS root_total_bytes_billed,
      IF(is_root_job, tib_billed,         NULL) AS root_tib_billed,
      -- statement 系: 実際に計算した文としての消費。
      -- 値が入るのは CHILD と STANDALONE。PARENT は NULL。
      IF(is_cost_countable, total_slot_ms,      NULL) AS statement_total_slot_ms,
      IF(is_cost_countable, slot_hours,         NULL) AS statement_slot_hours,
      IF(is_cost_countable, total_bytes_billed, NULL) AS statement_total_bytes_billed,
      IF(is_cost_countable, tib_billed,         NULL) AS statement_tib_billed
    FROM classified
  """, job_cost_resolved_fqn, job_cost_fqn, job_cost_fqn, job_cost_fqn);

  -- --------------------------------------------------------------------------
  -- STEP 5: bqc_t_daily_cost -- 日 x fingerprint x 実行者 の集約
  -- --------------------------------------------------------------------------
  -- Looker Studio が実際に読むのはこちら。job 粒度より数桁小さいので速い。
  EXECUTE IMMEDIATE FORMAT(r"""
    CREATE OR REPLACE TABLE `%s` (
      usage_date              DATE      OPTIONS(description = '対象日 (UTC)。パーティションキー'),
      job_region              STRING    OPTIONS(description = 'リージョン'),
      normalized_fingerprint  STRING    OPTIONS(description = '正規化SQLの fingerprint'),
      executor_id             STRING    OPTIONS(description = '実行者 (subsystem_id または user_email)'),
      executor_source         STRING    OPTIONS(description = 'LABEL / USER_EMAIL'),
      pricing_model           STRING    OPTIONS(description = 'ON_DEMAND / CAPACITY'),
      reservation_id          STRING    OPTIONS(description = '予約。オンデマンドは NULL'),
      job_count               INT64     OPTIONS(description = '実行回数'),
      cache_hit_count         INT64     OPTIONS(description = 'キャッシュヒット回数。削減余地の指標'),
      error_count             INT64     OPTIONS(description = '失敗回数'),
      distinct_user_count     INT64     OPTIONS(description = 'この実行者IDの下にいた user_email の異なり数'),
      total_bytes_billed      INT64     OPTIONS(description = '課金対象バイト数の合計'),
      tib_billed              FLOAT64   OPTIONS(description = 'TiB 換算。単価を掛ければ金額'),
      total_slot_ms           INT64     OPTIONS(description = '消費スロット(ms)の合計'),
      slot_hours              FLOAT64   OPTIONS(description = 'スロット時間の合計'),
      normalized_query        STRING    OPTIONS(description = '正規化SQLの全文。normalized_fingerprint から一意に決まるので値は冗長だが、開発中に正規化の結果をこの表だけで確かめられるように持たせている。不要になったらこの列と 03 STEP 1 の該当行を落とす'),
      sample_raw_fingerprint  STRING    OPTIONS(description = 'この行に含まれる原文SQLのうち代表1件の MD5。job_cost.raw_fingerprint で実ジョブに辿るための手がかり'),
      distinct_raw_fingerprint_count INT64 OPTIONS(description = 'この行に畳み込まれた原文SQLの異なり数。大きいほどリテラルの違いを多く吸収できている＝正規化が効いている指標'),
      updated_at              TIMESTAMP OPTIONS(description = 'この行を最後に再構築した時刻')
    )
    PARTITION BY usage_date
    CLUSTER BY normalized_fingerprint, executor_id
    OPTIONS(description = 'BigQuery クエリコストの日次集約。Looker Studio の主データソース (レポートは bqc_vw_t_daily_cost_report 経由で読む)。保持期間は 03 の retention_days に従う。')
  """, daily_cost_fqn);

  -- --------------------------------------------------------------------------
  -- STEP 6: bqc_m_query_fingerprint -- fingerprint 次元
  -- --------------------------------------------------------------------------
  -- 1 行 = 1 fingerprint。「新しくコストを発生させた SQL」の判定に使う
  -- first_seen_date と、レポート表示用のプレビューを持つ。
  -- 03 が MERGE で更新し、first_seen_date は保持期間の中では LEAST() で後退させない。
  EXECUTE IMMEDIATE FORMAT(r"""
    CREATE OR REPLACE TABLE `%s` (
      normalized_fingerprint  STRING    OPTIONS(description = '正規化SQLの fingerprint。主キー'),
      normalizer_version      STRING    OPTIONS(description = 'この fingerprint を作った正規化ロジックのバージョン'),
      first_seen_date         DATE      OPTIONS(description = '保持期間内でこの SQL が最初に観測された日。新規コスト源の判定基準'),
      last_seen_date          DATE      OPTIONS(description = '最後に観測された日'),
      normalized_query        STRING    OPTIONS(description = '正規化SQLの全文。fingerprint あたり1行なのでここが実質の正本'),
      normalized_preview      STRING    OPTIONS(description = '正規化SQLの先頭100文字'),
      normalized_from_preview STRING    OPTIONS(description = '正規化SQLの最初の FROM 以降100文字'),
      referenced_tables_text  STRING    OPTIONS(description = '直近実行時の参照テーブル一覧 (改行区切り)'),
      retained_job_count      INT64     OPTIONS(description = '保持期間内の実行回数の合計'),
      retained_tib_billed     FLOAT64   OPTIONS(description = '保持期間内の課金対象バイト数 (TiB)'),
      retained_slot_hours     FLOAT64   OPTIONS(description = '保持期間内のスロット時間'),
      distinct_executor_count INT64     OPTIONS(description = 'この SQL を実行した実行者の異なり数'),
      updated_at              TIMESTAMP OPTIONS(description = 'この行を最後に更新した時刻')
    )
    CLUSTER BY normalized_fingerprint
    OPTIONS(description = 'SQL fingerprint の次元表。保持期間内での first_seen と表示用プレビューを持つ。03 が保持期間外の fingerprint を刈り取る。')
  """, query_dim_fqn);

  -- --------------------------------------------------------------------------
  -- STEP 7: bqc_vw_t_daily_cost_report -- レポート定義
  -- --------------------------------------------------------------------------
  -- レポート定義の正本。ブレンドを使わずに済むよう、集約 (bqc_t_daily_cost) と
  -- 次元 (bqc_m_query_fingerprint) をここで結合する。
  -- Looker Studio が実際に読むのは、03 がこれを焼き直した静的テーブル
  -- bqc_t_daily_cost_report のほう。列を足したいときはこのビューを直せば、
  -- 次回の 03 でテーブルのスキーマも追従する。
  -- 金額は単価がリージョン・エディションで変わるため、あえて格納も計算もしない。
  -- Looker Studio 側の計算フィールドで tib_billed に単価を掛けること（README 参照）。
  EXECUTE IMMEDIATE FORMAT(r"""
    CREATE OR REPLACE VIEW `%s`
    OPTIONS(description = 'レポート定義の正本。日次集約に fingerprint 次元を結合し、新規SQL判定フラグを付与したもの。Looker Studio は 03 が焼き直す bqc_t_daily_cost_report を読む。')
    AS
    SELECT
      d.usage_date,
      d.job_region,
      d.normalized_fingerprint,
      d.executor_id,
      d.executor_source,
      d.pricing_model,
      d.reservation_id,
      d.job_count,
      d.cache_hit_count,
      d.error_count,
      d.distinct_user_count,
      d.total_bytes_billed,
      d.tib_billed,
      d.total_slot_ms,
      d.slot_hours,
      d.sample_raw_fingerprint,
      d.distinct_raw_fingerprint_count,
      q.normalizer_version,
      q.first_seen_date,
      q.last_seen_date,
      -- 正規化SQLの全文は次元表（fingerprint あたり1行）側から取る。
      q.normalized_query,
      q.normalized_preview,
      q.normalized_from_preview,
      q.referenced_tables_text,
      q.retained_job_count,
      q.distinct_executor_count,
      DATE_DIFF(d.usage_date, q.first_seen_date, DAY) AS days_since_first_seen,
      -- 「その日に初めてコストを発生させた SQL」。Looker Studio ではこれを
      -- フィルタに掛けるだけで新規コスト源の一覧になる。
      q.first_seen_date = d.usage_date AS is_first_seen_date,
      DATE_TRUNC(d.usage_date, MONTH) AS usage_month
    FROM `%s` AS d
    LEFT JOIN `%s` AS q
      ON q.normalized_fingerprint = d.normalized_fingerprint
  """, report_view_fqn, daily_cost_fqn, query_dim_fqn);

  -- --------------------------------------------------------------------------
  -- 作成結果の確認
  -- --------------------------------------------------------------------------
  SELECT
    'bqc setup completed' AS status,
    @@location            AS job_region,
    dataset_fqn           AS dataset,
    udf_dataset_fqn       AS udf_dataset,
    normalize_udf_fqn     AS normalize_udf,
    job_cost_fqn          AS job_cost_table,
    job_cost_resolved_fqn AS job_cost_resolved_view,
    daily_cost_fqn        AS daily_cost_table,
    query_dim_fqn         AS query_fingerprint_table,
    report_view_fqn       AS report_definition_view,
    normalizer_version    AS normalizer_version,
    mask_backtick_identifiers AS mask_backtick_identifiers,
    smoke_test_result     AS udf_smoke_test_output;
END;
