-- ============================================================================
-- 03_refresh_reports.sql
-- bqc_t_job_cost -> bqc_t_daily_cost / bqc_m_query_fingerprint の再構築
-- ============================================================================
-- 02 の直後に日次で実行する。
--   STEP 1: 日次集約 bqc_t_daily_cost を対象期間だけ作り直す（MERGE で原子的に）
--   STEP 2: fingerprint 次元 bqc_m_query_fingerprint を更新する
--   STEP 3: 保持期間 (retention_days) を超えた行を 3 表から刈り取る
--   STEP 4: レポートビューを静的テーブル bqc_t_daily_cost_report に焼き直す
--
-- 作り直す起点日は自己修復型で決める。基本は直近 refresh_lookback_days 日ぶんだが、
-- job_cost にあって daily_cost に無い日があればその最古日まで遡る。初回は daily_cost が
-- 空なので自動的に全期間が対象になる。refresh_lookback_days は 02 の
-- incremental_lookback_days より広く取ること（狭くても遡りで埋まるが、毎回の
-- スキャン量が無駄に増える）。
--
-- first_seen_date は保持期間の中では LEAST() で後退させない。これが
-- 「新しくコストを発生させた SQL」の判定基準になる。
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
  -- Project-token substitution
  DECLARE project_token_pattern STRING DEFAULT r'^([^-]+)';
  -- Datasets (repository)
  DECLARE repository_dataset STRING DEFAULT 'bq_cost_repository';
  -- Table naming
  DECLARE table_name_prefix STRING DEFAULT '';
  DECLARE table_name_suffix STRING DEFAULT '';
  --
  -- Variable notes (keyed by name):
  --   project_token_pattern / repository_dataset / table_name_*
  --     01・02 と必ず同じ値にすること。

  -- --------------------------------------------------------------------------
  -- [B] BEHAVIOR OPTIONS -- defaults are safe; tune as needed
  -- --------------------------------------------------------------------------
  DECLARE default_project_id STRING;
  -- 作り直す日数。02 の incremental_lookback_days より広く取ること。
  DECLARE refresh_lookback_days INT64 DEFAULT 7;
  -- 保持期間。この日数より古い行を STEP 3 で削除する。
  -- 既定の 180 は INFORMATION_SCHEMA.JOBS の履歴保持期間そのもの。つまり削除対象は
  -- 「JOBS 側でも既に消えている期間」だけなので、元データから作り直せる範囲は
  -- 失われない。JOBS より長く持ちたくなったらこの値を伸ばすこと。
  DECLARE retention_days INT64 DEFAULT 180;
  -- 刈り取り自体を止めたい場合に FALSE。表は際限なく伸びる。
  DECLARE enable_retention_pruning BOOL DEFAULT TRUE;

  -- --------------------------------------------------------------------------
  -- [C] DERIVED / INTERNAL -- from [A]; DO NOT edit
  -- --------------------------------------------------------------------------
  DECLARE repository_project_id STRING DEFAULT NULL;
  DECLARE project_token STRING;
  DECLARE job_cost_fqn STRING;
  DECLARE job_cost_resolved_fqn STRING;
  DECLARE daily_cost_fqn STRING;
  DECLARE query_dim_fqn STRING;
  DECLARE report_view_fqn STRING;
  DECLARE report_table_fqn STRING;
  DECLARE refresh_from_date DATE;
  DECLARE retention_cutoff_date DATE;
  -- 診断用。どこで止まったのかを最後の SELECT で見えるようにするためだけの変数。
  DECLARE job_cost_rows_in_window INT64 DEFAULT 0;
  DECLARE countable_rows_in_window INT64 DEFAULT 0;
  DECLARE daily_cost_merged_rows INT64 DEFAULT 0;
  DECLARE query_dim_merged_rows INT64 DEFAULT 0;
  DECLARE daily_cost_rows_after INT64 DEFAULT 0;
  DECLARE query_dim_rows_after INT64 DEFAULT 0;
  DECLARE report_table_rows INT64 DEFAULT 0;

  EXECUTE IMMEDIATE FORMAT(
    "SELECT DISTINCT catalog_name FROM `region-%s`.INFORMATION_SCHEMA.SCHEMATA LIMIT 1",
    @@location
  ) INTO default_project_id;
  ASSERT default_project_id IS NOT NULL AS
    'Could not auto-detect the project id from INFORMATION_SCHEMA.SCHEMATA; set default_project_id to a literal.';
  SET repository_project_id = COALESCE(repository_project_id, default_project_id);

  SET project_token =
    COALESCE(REGEXP_EXTRACT(default_project_id, project_token_pattern), '');
  SET repository_dataset = REPLACE(repository_dataset, '{project_token}', project_token);
  SET table_name_prefix = REPLACE(table_name_prefix, '{project_token}', project_token);
  SET table_name_suffix = REPLACE(table_name_suffix, '{project_token}', project_token);

  ASSERT REGEXP_CONTAINS(repository_dataset, r'^[A-Za-z0-9_]+$')
  AS 'repository_dataset must be letters/digits/underscore only (check for an unsubstituted {project_token}).';
  ASSERT refresh_lookback_days >= 1 AS 'refresh_lookback_days must be >= 1.';
  ASSERT retention_days >= 1 AS 'retention_days must be >= 1.';
  -- 保持期間が作り直し幅より狭いと、入れた直後の行をその実行の中で消してしまう。
  ASSERT retention_days > refresh_lookback_days
  AS 'retention_days must be greater than refresh_lookback_days (otherwise rows are pruned in the same run that rebuilds them).';

  SET job_cost_fqn = FORMAT(
    '%s.%s.%s', repository_project_id, repository_dataset,
    table_name_prefix || 'bqc_' || 't_' || 'job_cost' || table_name_suffix
  );
  -- 集計は必ず解決ビュー経由で行う。親 SCRIPT は子の合計を持つ集計行なので、
  -- 素の job_cost をそのまま足すと二重計上になる。
  SET job_cost_resolved_fqn = FORMAT(
    '%s.%s.%s', repository_project_id, repository_dataset,
    table_name_prefix || 'bqc_' || 'vw_t_' || 'job_cost_resolved' || table_name_suffix
  );
  SET daily_cost_fqn = FORMAT(
    '%s.%s.%s', repository_project_id, repository_dataset,
    table_name_prefix || 'bqc_' || 't_' || 'daily_cost' || table_name_suffix
  );
  SET query_dim_fqn = FORMAT(
    '%s.%s.%s', repository_project_id, repository_dataset,
    table_name_prefix || 'bqc_' || 'm_' || 'query_fingerprint' || table_name_suffix
  );
  -- 定義の正本はビュー、Looker が読むのは静的テーブル。名前は vw_ を落としただけの対。
  SET report_view_fqn = FORMAT(
    '%s.%s.%s', repository_project_id, repository_dataset,
    table_name_prefix || 'bqc_' || 'vw_t_' || 'daily_cost_report' || table_name_suffix
  );
  SET report_table_fqn = FORMAT(
    '%s.%s.%s', repository_project_id, repository_dataset,
    table_name_prefix || 'bqc_' || 't_' || 'daily_cost_report' || table_name_suffix
  );

  -- --------------------------------------------------------------------------
  -- 作り直す起点日の決定（自己修復型）
  -- --------------------------------------------------------------------------
  -- 基本は「直近 refresh_lookback_days 日」。ただし job_cost に在るのに daily_cost に
  -- 出ていない日があれば、その最古日まで遡る。
  --
  -- 「集約表が空なら全期間、そうでなければ直近」という分岐にしていたが、それだと
  -- 一度でも取りこぼした日が二度と埋まらない（集約が空でなくなった時点で直近しか
  -- 見なくなる）。取りこぼしの原因が何であれ、次の実行で自動的に埋まるようにする。
  -- 初回は daily_cost が空なので job_cost の最古日＝全期間が対象になる。
  EXECUTE IMMEDIATE FORMAT(r"""
    SELECT LEAST(
      DATE_SUB(CURRENT_DATE(), INTERVAL @refresh_lookback_days DAY),
      IFNULL(
        (
          SELECT MIN(j.creation_date)
          FROM (
            SELECT DISTINCT creation_date FROM `%s` WHERE is_cost_countable
          ) AS j
          LEFT JOIN (SELECT DISTINCT usage_date FROM `%s`) AS d
            ON d.usage_date = j.creation_date
          WHERE d.usage_date IS NULL
        ),
        DATE_SUB(CURRENT_DATE(), INTERVAL @refresh_lookback_days DAY)
      )
    )
  """, job_cost_resolved_fqn, daily_cost_fqn)
  INTO refresh_from_date
  USING refresh_lookback_days AS refresh_lookback_days;

  ASSERT refresh_from_date IS NOT NULL
  AS 'refresh_from_date resolved to NULL; the daily aggregate would silently rebuild nothing.';

  -- 保持期間より古い日はこの実行の STEP 3 でどのみち消えるので、作り直さない。
  IF enable_retention_pruning THEN
    SET refresh_from_date = GREATEST(
      refresh_from_date,
      DATE_SUB(CURRENT_DATE(), INTERVAL retention_days DAY)
    );
  END IF;

  -- 集約対象の母数。これが 0 なら原因は 03 ではなく 02（あるいは参照先データセットの
  -- 食い違い）にある、と最後のサマリだけで切り分けられるようにしておく。
  -- 全行と集計対象行を分けて数えるのは、親 SCRIPT の割合が見えるようにするため。
  EXECUTE IMMEDIATE FORMAT(
    r"""SELECT
          COUNT(*)                       AS all_rows,
          COUNTIF(is_cost_countable)     AS countable_rows
        FROM `%s`
        WHERE creation_date >= @refresh_from_date""",
    job_cost_resolved_fqn
  )
  INTO job_cost_rows_in_window, countable_rows_in_window
  USING refresh_from_date AS refresh_from_date;

  -- --------------------------------------------------------------------------
  -- STEP 1: bqc_t_daily_cost の再構築
  -- --------------------------------------------------------------------------
  -- DELETE + INSERT ではなく MERGE を使う。対象期間で source から消えた組み合わせを
  -- NOT MATCHED BY SOURCE で消せるので、途中で失敗しても集約が欠けた状態で
  -- 残らない（DELETE と INSERT の間で落ちる窓が無い）。
  EXECUTE IMMEDIATE FORMAT(r"""
    MERGE `%s` AS target
    USING (
      SELECT
        * EXCEPT(sample),
        -- 代表行から取り出す3列。個別に ANY_VALUE を書くと列ごとに別の行が
        -- 選ばれうるので、sample_query と sample_raw_fingerprint が対応しなく
        -- なる。STRUCT でまとめて1行ぶんだけ選ぶことで必ず揃う。
        sample.normalized_query AS normalized_query,
        sample.query            AS sample_query,
        sample.raw_fingerprint  AS sample_raw_fingerprint
      FROM (
      SELECT
        creation_date AS usage_date,
        job_region,
        normalized_fingerprint,
        executor_id,
        executor_source,
        pricing_model,
        reservation_id,
        COUNT(*)                        AS job_count,
        COUNTIF(cache_hit)              AS cache_hit_count,
        COUNTIF(is_error)               AS error_count,
        COUNT(DISTINCT user_email)      AS distinct_user_count,
        -- 解決ビューのコスト列は root 系（作業単位）と statement 系（文単位）に
        -- 分かれている。daily_cost は葉だけを集める表なので statement 系を使う。
        -- WHERE is_cost_countable と組み合わせれば、statement 系は必ず非 NULL。
        SUM(IFNULL(statement_total_bytes_billed, 0)) AS total_bytes_billed,
        SUM(IFNULL(statement_tib_billed, 0))         AS tib_billed,
        SUM(IFNULL(statement_total_slot_ms, 0))      AS total_slot_ms,
        SUM(IFNULL(statement_slot_hours, 0))         AS slot_hours,
        -- 表示用の代表行。直近の実行を1件だけ選び、正規化SQL・原文SQL・原文の
        -- fingerprint をまとめて取り出す（上の外側 SELECT で展開する）。
        ARRAY_AGG(
          STRUCT(normalized_query, query, raw_fingerprint)
          ORDER BY creation_time DESC
          LIMIT 1
        )[SAFE_OFFSET(0)]                            AS sample,
        -- 原文の fingerprint は 1 つの normalized_fingerprint に対して複数ありうる
        -- （リテラルが違うぶんだけ別物になる）。だから粒度キーには入れず、
        -- 代表1件と異なり数として持つ。キーに入れると日 × リテラル違いで
        -- 行が膨らみ、正規化した意味が無くなる。
        COUNT(DISTINCT raw_fingerprint)              AS distinct_raw_fingerprint_count,
        CURRENT_TIMESTAMP()             AS updated_at
      FROM `%s`
      WHERE creation_date >= @refresh_from_date
        -- 親 SCRIPT を除く。これを外すと集計が二重になる。
        AND is_cost_countable
      GROUP BY
        usage_date, job_region, normalized_fingerprint,
        executor_id, executor_source, pricing_model, reservation_id
      )
    ) AS source
    ON  target.usage_date             = source.usage_date
    AND target.job_region             = source.job_region
    AND target.normalized_fingerprint = source.normalized_fingerprint
    AND target.executor_id            = source.executor_id
    AND target.executor_source        = source.executor_source
    AND target.pricing_model          = source.pricing_model
    -- reservation_id は NULL を取りうる。素の = だと NULL 同士が一致せず
    -- 同じ組み合わせが毎回 INSERT されて重複するので IFNULL で比較する。
    AND IFNULL(target.reservation_id, '') = IFNULL(source.reservation_id, '')
    WHEN MATCHED THEN UPDATE SET
      job_count           = source.job_count,
      cache_hit_count     = source.cache_hit_count,
      error_count         = source.error_count,
      distinct_user_count = source.distinct_user_count,
      total_bytes_billed  = source.total_bytes_billed,
      tib_billed          = source.tib_billed,
      total_slot_ms       = source.total_slot_ms,
      slot_hours          = source.slot_hours,
      normalized_query    = source.normalized_query,
      sample_query        = source.sample_query,
      sample_raw_fingerprint = source.sample_raw_fingerprint,
      distinct_raw_fingerprint_count = source.distinct_raw_fingerprint_count,
      updated_at          = source.updated_at
    WHEN NOT MATCHED BY TARGET THEN
      -- INSERT ROW（列名省略）は target の列順に完全依存するので、列を明示する。
      INSERT (
        usage_date, job_region, normalized_fingerprint, executor_id,
        executor_source, pricing_model, reservation_id, job_count,
        cache_hit_count, error_count, distinct_user_count, total_bytes_billed,
        tib_billed, total_slot_ms, slot_hours, normalized_query,
        sample_query, sample_raw_fingerprint, distinct_raw_fingerprint_count,
        updated_at
      ) VALUES (
        source.usage_date, source.job_region, source.normalized_fingerprint,
        source.executor_id, source.executor_source, source.pricing_model,
        source.reservation_id, source.job_count, source.cache_hit_count,
        source.error_count, source.distinct_user_count, source.total_bytes_billed,
        source.tib_billed, source.total_slot_ms, source.slot_hours,
        source.normalized_query, source.sample_query,
        source.sample_raw_fingerprint, source.distinct_raw_fingerprint_count,
        source.updated_at
      )
    WHEN NOT MATCHED BY SOURCE AND target.usage_date >= @refresh_from_date THEN
      DELETE
  """, daily_cost_fqn, job_cost_resolved_fqn)
  USING refresh_from_date AS refresh_from_date;

  SET daily_cost_merged_rows = @@row_count;

  -- --------------------------------------------------------------------------
  -- STEP 2: bqc_m_query_fingerprint の更新
  -- --------------------------------------------------------------------------
  -- 合計値は daily_cost の保持期間全体から都度計算し直す（差分加算しないので
  -- 再実行が安全）。first_seen_date は LEAST で過去側に倒すので、02 の増分幅が
  -- 狭くても既に記録した初回観測日が上書きで新しくなることはない。
  EXECUTE IMMEDIATE FORMAT(r"""
    MERGE `%s` AS target
    USING (
      WITH fingerprint_totals AS (
        SELECT
          normalized_fingerprint,
          MIN(usage_date)             AS first_seen_date,
          MAX(usage_date)             AS last_seen_date,
          SUM(job_count)              AS retained_job_count,
          SUM(tib_billed)             AS retained_tib_billed,
          SUM(slot_hours)             AS retained_slot_hours,
          COUNT(DISTINCT executor_id) AS distinct_executor_count
        FROM `%s`
        GROUP BY normalized_fingerprint
      ),
      -- 表示用の代表サンプル。同じ fingerprint なら正規化SQLは定義上同一なので、
      -- 最新の 1 件を取れば足りる。参照テーブルだけはワイルドカード展開の差で
      -- 揺れうるため「直近の実行時点のもの」という意味になる。
      fingerprint_sample AS (
        SELECT
          normalized_fingerprint,
          normalizer_version,
          normalized_query,
          normalized_preview,
          normalized_from_preview,
          referenced_tables_text
        FROM `%s`
        WHERE is_cost_countable
        QUALIFY ROW_NUMBER() OVER (
          PARTITION BY normalized_fingerprint
          ORDER BY creation_time DESC
        ) = 1
      )
      SELECT
        t.normalized_fingerprint,
        s.normalizer_version,
        t.first_seen_date,
        t.last_seen_date,
        s.normalized_query,
        s.normalized_preview,
        s.normalized_from_preview,
        s.referenced_tables_text,
        t.retained_job_count,
        t.retained_tib_billed,
        t.retained_slot_hours,
        t.distinct_executor_count
      FROM fingerprint_totals AS t
      LEFT JOIN fingerprint_sample AS s
        ON s.normalized_fingerprint = t.normalized_fingerprint
    ) AS source
    ON target.normalized_fingerprint = source.normalized_fingerprint
    WHEN MATCHED THEN UPDATE SET
      -- LEAST/GREATEST は引数に NULL があると NULL を返すので IFNULL で保護する。
      first_seen_date = LEAST(
        IFNULL(target.first_seen_date, source.first_seen_date),
        source.first_seen_date
      ),
      last_seen_date = GREATEST(
        IFNULL(target.last_seen_date, source.last_seen_date),
        source.last_seen_date
      ),
      -- job_cost を刈り込んだあとはサンプルが取れなくなるので、
      -- 取れなかった場合は既存のプレビューをそのまま残す。
      normalizer_version      = IFNULL(source.normalizer_version, target.normalizer_version),
      normalized_query        = IFNULL(source.normalized_query, target.normalized_query),
      normalized_preview      = IFNULL(source.normalized_preview, target.normalized_preview),
      normalized_from_preview = IFNULL(source.normalized_from_preview, target.normalized_from_preview),
      referenced_tables_text  = IFNULL(source.referenced_tables_text, target.referenced_tables_text),
      retained_job_count      = source.retained_job_count,
      retained_tib_billed     = source.retained_tib_billed,
      retained_slot_hours     = source.retained_slot_hours,
      distinct_executor_count = source.distinct_executor_count,
      updated_at              = CURRENT_TIMESTAMP()
    WHEN NOT MATCHED THEN INSERT (
      normalized_fingerprint,
      normalizer_version,
      first_seen_date,
      last_seen_date,
      normalized_query,
      normalized_preview,
      normalized_from_preview,
      referenced_tables_text,
      retained_job_count,
      retained_tib_billed,
      retained_slot_hours,
      distinct_executor_count,
      updated_at
    ) VALUES (
      source.normalized_fingerprint,
      source.normalizer_version,
      source.first_seen_date,
      source.last_seen_date,
      source.normalized_query,
      source.normalized_preview,
      source.normalized_from_preview,
      source.referenced_tables_text,
      source.retained_job_count,
      source.retained_tib_billed,
      source.retained_slot_hours,
      source.distinct_executor_count,
      CURRENT_TIMESTAMP()
    )
  """, query_dim_fqn, daily_cost_fqn, job_cost_resolved_fqn);

  SET query_dim_merged_rows = @@row_count;

  -- --------------------------------------------------------------------------
  -- STEP 3: 保持期間を超えた行の刈り取り
  -- --------------------------------------------------------------------------
  -- 対象期間は JOBS が持っている範囲だけ、という方針なので、それより古い行は残さない。
  -- 既定の retention_days = 180 は JOBS の履歴保持期間と同じなので、消えるのは
  -- 「JOBS からも既に消えている期間」に限られる＝再取得できるデータは失われない。
  --
  -- fingerprint 次元は last_seen_date で判定する。保持期間内に一度でも実行された
  -- SQL は、first_seen が古くても残す（新規判定の基準を保つため）。
  --
  -- job_cost は creation_date で切るため、境界をまたぐスクリプトでは親だけが消えて
  -- 子が残る「孤児」が生じる。解決ビューは親行の実在で root を判定するので、
  -- 孤児は自分自身が作業単位の代表になり、root 系の合計から抜け落ちることはない。
  IF enable_retention_pruning THEN
    SET retention_cutoff_date = DATE_SUB(CURRENT_DATE(), INTERVAL retention_days DAY);

    EXECUTE IMMEDIATE FORMAT(
      'DELETE FROM `%s` WHERE creation_date < @retention_cutoff_date', job_cost_fqn
    ) USING retention_cutoff_date AS retention_cutoff_date;

    EXECUTE IMMEDIATE FORMAT(
      'DELETE FROM `%s` WHERE usage_date < @retention_cutoff_date', daily_cost_fqn
    ) USING retention_cutoff_date AS retention_cutoff_date;

    EXECUTE IMMEDIATE FORMAT(
      'DELETE FROM `%s` WHERE last_seen_date < @retention_cutoff_date', query_dim_fqn
    ) USING retention_cutoff_date AS retention_cutoff_date;
  END IF;

  -- --------------------------------------------------------------------------
  -- STEP 4: レポートビューの静的テーブル化
  -- --------------------------------------------------------------------------
  -- ビューのままだと Looker Studio が開くたびに集約と JOIN が走り、フィルタが
  -- 計算列に当たるためクラスタプルーニングも効かない。中身は日次でしか変わらないので
  -- テーブルへ焼いておく。
  --
  -- 定義の正本はあくまでビュー側（01 の CREATE OR REPLACE VIEW）。列を足したいときは
  -- ビューを直せば、次回の 03 でテーブルのスキーマも追従する。
  --
  -- 刈り取り（STEP 3）の後に実行するので、テーブルは常に刈り取り後の状態を映す。
  -- CREATE OR REPLACE なので 01 側での作成は不要。
  EXECUTE IMMEDIATE FORMAT(r"""
    CREATE OR REPLACE TABLE `%s`
    PARTITION BY usage_date
    CLUSTER BY normalized_fingerprint, executor_id
    OPTIONS(description = 'bqc_vw_t_daily_cost_report のスナップショット。Looker Studio はこちらを読む。03 の実行ごとに全置換される。')
    AS
    SELECT
      *,
      -- ダッシュボード上でデータの鮮度を出せるように焼いた時刻を持たせる。
      CURRENT_TIMESTAMP() AS snapshot_at
    FROM `%s`
  """, report_table_fqn, report_view_fqn);

  EXECUTE IMMEDIATE FORMAT('SELECT COUNT(*) FROM `%s`', report_table_fqn)
    INTO report_table_rows;

  -- --------------------------------------------------------------------------
  -- 再構築結果（切り分け用の診断値を含む）
  -- --------------------------------------------------------------------------
  -- daily_cost に行が入らなかったときは、この出力だけで原因を絞り込めるようにしてある。
  --   job_cost_rows_in_window = 0 → 集約する母数が無い。02 が入れていないか、
  --                                 参照している job_cost が別データセットのもの。
  --   countable_rows_in_window = 0 → 全行が親 SCRIPT 扱いになっている。
  --                                 解決ビューの判定を疑う。
  --   countable > 0 かつ daily_cost_merged_rows = 0
  --                               → 集約側の問題。refresh_from_date を確認する。
  EXECUTE IMMEDIATE FORMAT('SELECT COUNT(*) FROM `%s`', daily_cost_fqn)
    INTO daily_cost_rows_after;
  EXECUTE IMMEDIATE FORMAT('SELECT COUNT(*) FROM `%s`', query_dim_fqn)
    INTO query_dim_rows_after;

  SELECT
    'bqc refresh completed'  AS status,
    job_cost_fqn             AS job_cost_table,
    daily_cost_fqn           AS daily_cost_table,
    query_dim_fqn            AS query_fingerprint_table,
    report_table_fqn         AS looker_studio_table,
    refresh_from_date        AS rebuilt_from_date,
    job_cost_rows_in_window  AS job_cost_rows_in_window,
    countable_rows_in_window AS countable_rows_in_window,
    daily_cost_merged_rows   AS daily_cost_rows_affected,
    query_dim_merged_rows    AS query_fingerprint_rows_affected,
    daily_cost_rows_after    AS daily_cost_total_rows,
    query_dim_rows_after     AS query_fingerprint_total_rows,
    report_table_rows        AS looker_studio_table_rows,
    retention_cutoff_date    AS pruned_before;
END;
