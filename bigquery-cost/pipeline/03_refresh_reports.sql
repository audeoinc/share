-- ============================================================================
-- 03_refresh_reports.sql
-- bqc_t_job_cost -> bqc_t_daily_cost / bqc_m_query_fingerprint の再構築
-- ============================================================================
-- 02 の直後に日次で実行する。
--   STEP 1: 日次集約 bqc_t_daily_cost を対象期間だけ作り直す（MERGE で原子的に）
--   STEP 2: fingerprint 次元 bqc_m_query_fingerprint を更新する
--   STEP 3: 保持期間 (retention_days) を超えた行を 3 表から刈り取る
--
-- 初回（集約表が空）は job_cost の全期間を作り直し、以降は
-- refresh_lookback_days だけを作り直す。02 の incremental_lookback_days より
-- 必ず広く取ること。狭いと、02 が遅れて取り込んだ古い日付の行が集約に反映されない。
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
  DECLARE daily_cost_fqn STRING;
  DECLARE query_dim_fqn STRING;
  DECLARE daily_cost_row_count INT64;
  DECLARE refresh_from_date DATE;
  DECLARE retention_cutoff_date DATE;

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
  SET daily_cost_fqn = FORMAT(
    '%s.%s.%s', repository_project_id, repository_dataset,
    table_name_prefix || 'bqc_' || 't_' || 'daily_cost' || table_name_suffix
  );
  SET query_dim_fqn = FORMAT(
    '%s.%s.%s', repository_project_id, repository_dataset,
    table_name_prefix || 'bqc_' || 'm_' || 'query_fingerprint' || table_name_suffix
  );

  -- 集約表が空なら全期間、そうでなければ直近だけを作り直す。
  EXECUTE IMMEDIATE FORMAT('SELECT COUNT(*) FROM `%s`', daily_cost_fqn)
    INTO daily_cost_row_count;

  IF daily_cost_row_count = 0 THEN
    EXECUTE IMMEDIATE FORMAT(
      'SELECT IFNULL(MIN(creation_date), CURRENT_DATE()) FROM `%s`', job_cost_fqn
    ) INTO refresh_from_date;
  ELSE
    SET refresh_from_date = DATE_SUB(CURRENT_DATE(), INTERVAL refresh_lookback_days DAY);
  END IF;

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
        SUM(IFNULL(total_bytes_billed, 0)) AS total_bytes_billed,
        SUM(IFNULL(tib_billed, 0))         AS tib_billed,
        SUM(IFNULL(total_slot_ms, 0))      AS total_slot_ms,
        SUM(IFNULL(slot_hours, 0))         AS slot_hours,
        CURRENT_TIMESTAMP()             AS updated_at
      FROM `%s`
      WHERE creation_date >= @refresh_from_date
      GROUP BY
        usage_date, job_region, normalized_fingerprint,
        executor_id, executor_source, pricing_model, reservation_id
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
      updated_at          = source.updated_at
    WHEN NOT MATCHED BY TARGET THEN
      INSERT ROW
    WHEN NOT MATCHED BY SOURCE AND target.usage_date >= @refresh_from_date THEN
      DELETE
  """, daily_cost_fqn, job_cost_fqn)
  USING refresh_from_date AS refresh_from_date;

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
          normalized_preview,
          normalized_from_preview,
          referenced_tables_text
        FROM `%s`
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
      source.normalized_preview,
      source.normalized_from_preview,
      source.referenced_tables_text,
      source.retained_job_count,
      source.retained_tib_billed,
      source.retained_slot_hours,
      source.distinct_executor_count,
      CURRENT_TIMESTAMP()
    )
  """, query_dim_fqn, daily_cost_fqn, job_cost_fqn);

  -- --------------------------------------------------------------------------
  -- STEP 3: 保持期間を超えた行の刈り取り
  -- --------------------------------------------------------------------------
  -- 対象期間は JOBS が持っている範囲だけ、という方針なので、それより古い行は残さない。
  -- 既定の retention_days = 180 は JOBS の履歴保持期間と同じなので、消えるのは
  -- 「JOBS からも既に消えている期間」に限られる＝再取得できるデータは失われない。
  --
  -- fingerprint 次元は last_seen_date で判定する。保持期間内に一度でも実行された
  -- SQL は、first_seen が古くても残す（新規判定の基準を保つため）。
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
  -- 再構築結果
  -- --------------------------------------------------------------------------
  EXECUTE IMMEDIATE FORMAT(r"""
    SELECT
      'bqc refresh completed' AS status,
      (SELECT COUNT(*) FROM `%s`)                      AS daily_cost_rows,
      (SELECT COUNT(*) FROM `%s`)                      AS fingerprint_rows,
      (SELECT MIN(usage_date) FROM `%s`)               AS min_usage_date,
      (SELECT MAX(usage_date) FROM `%s`)               AS max_usage_date,
      (SELECT COUNTIF(first_seen_date = CURRENT_DATE()) FROM `%s`)
        AS fingerprints_first_seen_today,
      @retention_cutoff_date AS pruned_before
  """, daily_cost_fqn, query_dim_fqn, daily_cost_fqn, daily_cost_fqn, query_dim_fqn)
  USING retention_cutoff_date AS retention_cutoff_date;
END;
