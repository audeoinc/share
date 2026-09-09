-- ============================================================================
-- 02_load_job_cost.sql
-- INFORMATION_SCHEMA.JOBS -> bqc_t_job_cost の増分取り込み
-- ============================================================================
-- 日次で実行する（スケジュールドクエリ推奨）。初回は自動的に
-- initial_lookback_days（既定 120 日）を遡ってバックフィルし、2 回目以降は
-- incremental_lookback_days（既定 3 日）だけを読み直す。MERGE なので何度流しても
-- 二重登録にならない。
--
-- 設計上のポイント:
--   * SCRIPT 親ジョブは除外し、子ジョブだけを取り込む。親は子の合計を持つため、
--     両方入れると二重計上になる。除外は IFNULL(statement_type,'') で行う
--     （statement_type != 'SCRIPT' と書くと NULL 行が黙って落ちる）。
--   * ラベル subsystemid は子ジョブに継承されることを実測で確認済み（2026-09）。
--     そのため親を引き当てる join は持たない。継承されない環境に移す場合は
--     parent_job_id で親のラベルを引く必要がある。
--   * リージョンは @@location 単一。複数リージョンを見たい場合は @@location を
--     変えて本スクリプトを再実行する。job_region 列で混在して蓄積できる。
--   * 時刻はすべて UTC のまま保持する。
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
  -- GCP project: 実行時に自動取得する（DECLARE は [B]）。
  -- Project-token substitution
  DECLARE project_token_pattern STRING DEFAULT r'^([^-]+)';
  -- Datasets (repository)
  DECLARE repository_dataset STRING DEFAULT 'bq_cost_repository';
  -- Table naming
  DECLARE table_name_prefix STRING DEFAULT '';
  DECLARE table_name_suffix STRING DEFAULT '';
  -- UDF naming
  DECLARE udf_name_prefix STRING DEFAULT '';
  DECLARE udf_name_suffix STRING DEFAULT '';
  -- Executor identification
  DECLARE executor_label_key STRING DEFAULT 'subsystemid';
  --
  -- Variable notes (keyed by name):
  --   project_token_pattern / repository_dataset / table_name_* / udf_name_*
  --     01 と必ず同じ値にすること。名前が食い違うと別の表を作りに行く。
  --   executor_label_key
  --     実行者を識別するジョブラベルのキー。BigQuery のラベルキーは小文字のみ
  --     なので 'subsystemid'（'subsystemId' ではない）。この値が付いていない
  --     ジョブは user_email にフォールバックする。

  -- --------------------------------------------------------------------------
  -- [B] BEHAVIOR OPTIONS -- defaults are safe; tune as needed
  -- --------------------------------------------------------------------------
  DECLARE default_project_id STRING;
  -- 初回（表が空）のときに遡る日数。JOBS の履歴保持は 180 日なのでそれが上限。
  -- 開発中は 120 日で回す想定。
  DECLARE initial_lookback_days INT64 DEFAULT 120;
  -- 2 回目以降に読み直す日数。遅延到着・実行中だったジョブを拾い直すため 1 より大きくする。
  DECLARE incremental_lookback_days INT64 DEFAULT 3;
  -- 1 回のスキャンで読む日数。120 日を 1 クエリで舐めると
  -- 「Resources exceeded」やタイムアウトになりやすいので分割して回す。
  DECLARE load_chunk_days INT64 DEFAULT 15;
  -- 取り込むジョブ種別。コストの主因は QUERY。LOAD/EXTRACT/COPY も見たい場合に追加する。
  DECLARE collected_job_types ARRAY<STRING> DEFAULT ['QUERY'];
  -- 正規化ロジックのバージョン。01 の値と揃える。
  DECLARE normalizer_version STRING DEFAULT 'v1';

  -- --------------------------------------------------------------------------
  -- [C] DERIVED / INTERNAL -- from [A]; DO NOT edit
  -- --------------------------------------------------------------------------
  DECLARE repository_project_id STRING DEFAULT NULL;
  DECLARE source_project_id STRING DEFAULT NULL;
  DECLARE project_token STRING;
  DECLARE job_cost_fqn STRING;
  DECLARE normalize_udf_fqn STRING;
  DECLARE jobs_region_fqn STRING;
  DECLARE merge_sql STRING;
  DECLARE existing_row_count INT64;
  DECLARE lookback_days INT64;
  DECLARE window_start TIMESTAMP;
  DECLARE window_end TIMESTAMP;
  DECLARE chunk_start TIMESTAMP;
  DECLARE chunk_end TIMESTAMP;
  DECLARE chunk_count INT64 DEFAULT 0;

  EXECUTE IMMEDIATE FORMAT(
    "SELECT DISTINCT catalog_name FROM `region-%s`.INFORMATION_SCHEMA.SCHEMATA LIMIT 1",
    @@location
  ) INTO default_project_id;
  ASSERT default_project_id IS NOT NULL AS
    'Could not auto-detect the project id from INFORMATION_SCHEMA.SCHEMATA; set default_project_id to a literal.';
  SET repository_project_id = COALESCE(repository_project_id, default_project_id);
  SET source_project_id = COALESCE(source_project_id, default_project_id);

  SET project_token =
    COALESCE(REGEXP_EXTRACT(default_project_id, project_token_pattern), '');
  SET repository_dataset = REPLACE(repository_dataset, '{project_token}', project_token);
  SET table_name_prefix = REPLACE(table_name_prefix, '{project_token}', project_token);
  SET table_name_suffix = REPLACE(table_name_suffix, '{project_token}', project_token);
  SET udf_name_prefix = REPLACE(udf_name_prefix, '{project_token}', project_token);
  SET udf_name_suffix = REPLACE(udf_name_suffix, '{project_token}', project_token);

  ASSERT REGEXP_CONTAINS(repository_dataset, r'^[A-Za-z0-9_]+$')
  AS 'repository_dataset must be letters/digits/underscore only (check for an unsubstituted {project_token}).';
  ASSERT initial_lookback_days BETWEEN 1 AND 180
  AS 'initial_lookback_days must be between 1 and 180 (INFORMATION_SCHEMA.JOBS keeps 180 days of history).';
  ASSERT incremental_lookback_days BETWEEN 1 AND 180
  AS 'incremental_lookback_days must be between 1 and 180.';
  ASSERT load_chunk_days >= 1 AS 'load_chunk_days must be >= 1.';
  ASSERT ARRAY_LENGTH(collected_job_types) > 0 AS 'collected_job_types must not be empty.';

  SET job_cost_fqn = FORMAT(
    '%s.%s.%s',
    repository_project_id,
    repository_dataset,
    table_name_prefix || 'bqc_' || 't_' || 'job_cost' || table_name_suffix
  );
  SET normalize_udf_fqn = FORMAT(
    '%s.%s.%s',
    repository_project_id,
    repository_dataset,
    udf_name_prefix || 'bqc_' || 'normalize_sql' || udf_name_suffix
  );
  -- region 修飾識別子のバッククォート内側だけを組み立てる。
  -- 参照は `<project>.region-<location>`.INFORMATION_SCHEMA.JOBS_BY_PROJECT の形。
  SET jobs_region_fqn = FORMAT('%s.region-%s', source_project_id, @@location);

  -- --------------------------------------------------------------------------
  -- 取り込み幅の決定: 表が空なら初回バックフィル、そうでなければ増分
  -- --------------------------------------------------------------------------
  EXECUTE IMMEDIATE FORMAT('SELECT COUNT(*) FROM `%s`', job_cost_fqn)
    INTO existing_row_count;

  SET lookback_days = IF(
    existing_row_count = 0,
    initial_lookback_days,
    incremental_lookback_days
  );

  SET window_end = CURRENT_TIMESTAMP();
  SET window_start = TIMESTAMP_SUB(window_end, INTERVAL lookback_days DAY);
  SET chunk_start = window_start;

  -- --------------------------------------------------------------------------
  -- MERGE テンプレート（チャンクごとに USING の値だけ差し替えて実行する）
  -- --------------------------------------------------------------------------
  -- INSERT のみで UPDATE 分岐を持たない。完了済みジョブの実績は不変なので、
  -- 既に取り込んだ行を上書きする理由がない＝再実行が安全かつ安価になる。
  -- 正規化ロジックを変えて過去分を作り直したい場合は、対象パーティションを
  -- 明示的に削除してから流し直すこと（normalizer_version 列で見分けられる）。
  SET merge_sql = FORMAT(r"""
    MERGE `%s` AS target
    USING (
      WITH raw_jobs AS (
        SELECT
          project_id,
          job_id,
          parent_job_id,
          creation_time,
          start_time,
          end_time,
          user_email,
          labels,
          job_type,
          statement_type,
          cache_hit,
          error_result,
          reservation_id,
          total_bytes_processed,
          total_bytes_billed,
          total_slot_ms,
          referenced_tables,
          query
        FROM `%s`.INFORMATION_SCHEMA.JOBS_BY_PROJECT
        WHERE creation_time >= @window_start
          AND creation_time <  @window_end
          AND state = 'DONE'
          AND query IS NOT NULL
          AND job_type IN UNNEST(@collected_job_types)
          -- SCRIPT 親は子ジョブの合計を持つため、両方入れると二重計上になる。
          -- statement_type != 'SCRIPT' と書くと statement_type が NULL の行まで
          -- 三値論理で黙って落ちるので、必ず IFNULL を噛ませて比較する。
          AND IFNULL(statement_type, '') != 'SCRIPT'
      ),
      deduped AS (
        SELECT *
        FROM raw_jobs
        -- MERGE は同一キーに複数の source 行があると実行時エラーになる。
        -- JOBS は 1 ジョブ 1 行のはずだが、保険として明示的に 1 行へ絞る。
        QUALIFY ROW_NUMBER() OVER (
          PARTITION BY project_id, job_id
          ORDER BY creation_time DESC
        ) = 1
      ),
      enriched AS (
        SELECT
          j.*,
          -- ラベルはキー重複しないので LIMIT 1 で確定する。
          (
            SELECT l.value
            FROM UNNEST(j.labels) AS l
            WHERE l.key = @executor_label_key
            LIMIT 1
          ) AS subsystem_id,
          -- 参照テーブルは fingerprint の入力にも使うので、順序を固定して連結する。
          -- Looker Studio は ARRAY を読めないため文字列で持つ。
          (
            SELECT STRING_AGG(
              CONCAT(rt.project_id, '.', rt.dataset_id, '.', rt.table_id),
              '\n'
              ORDER BY CONCAT(rt.project_id, '.', rt.dataset_id, '.', rt.table_id)
            )
            FROM UNNEST(j.referenced_tables) AS rt
          ) AS referenced_tables_text,
          ARRAY_LENGTH(j.referenced_tables) AS referenced_table_count,
          `%s`(j.query) AS normalized_query
        FROM deduped AS j
      )
      -- 列の順序は 01 の CREATE TABLE と一致させること（INSERT ROW のため）。
      SELECT
        @job_region AS job_region,
        project_id,
        job_id,
        parent_job_id,
        creation_time,
        DATE(creation_time) AS creation_date,
        start_time,
        end_time,
        TIMESTAMP_DIFF(end_time, start_time, MILLISECOND) AS elapsed_ms,
        user_email,
        subsystem_id,
        COALESCE(subsystem_id, user_email) AS executor_id,
        IF(subsystem_id IS NULL, 'USER_EMAIL', 'LABEL') AS executor_source,
        job_type,
        statement_type,
        IFNULL(cache_hit, FALSE) AS cache_hit,
        error_result IS NOT NULL AS is_error,
        error_result.reason AS error_reason,
        reservation_id,
        -- 予約が付いていればキャパシティ課金＝スロットが課金の基礎、
        -- 付いていなければオンデマンド＝課金対象バイト数が基礎。
        IF(reservation_id IS NULL, 'ON_DEMAND', 'CAPACITY') AS pricing_model,
        total_bytes_processed,
        total_bytes_billed,
        IFNULL(total_bytes_billed, 0) / POW(1024, 4) AS tib_billed,
        total_slot_ms,
        IFNULL(total_slot_ms, 0) / 3600000 AS slot_hours,
        referenced_table_count,
        referenced_tables_text,
        query,
        TO_HEX(MD5(query)) AS raw_fingerprint,
        normalized_query,
        -- 識別子の大小文字差を吸収するため UPPER してからハッシュ化する。
        TO_HEX(MD5(UPPER(normalized_query))) AS normalized_fingerprint,
        TO_HEX(MD5(CONCAT(
          UPPER(normalized_query), '|', IFNULL(referenced_tables_text, '')
        ))) AS normalized_fingerprint_t,
        SUBSTR(normalized_query, 1, 100) AS normalized_preview,
        -- 先頭 100 文字は SELECT 句で終わって FROM に届かないことが多いので、
        -- 最初の FROM 以降 100 文字も別に持つ。
        SUBSTR(
          REGEXP_EXTRACT(normalized_query, r'(?i)\bFROM\b.*'), 1, 100
        ) AS normalized_from_preview,
        @normalizer_version AS normalizer_version,
        CURRENT_TIMESTAMP() AS loaded_at
      FROM enriched
    ) AS source
    ON  target.job_region = source.job_region
    AND target.project_id = source.project_id
    AND target.job_id     = source.job_id
    WHEN NOT MATCHED THEN
      INSERT ROW
  """, job_cost_fqn, jobs_region_fqn, normalize_udf_fqn);

  -- --------------------------------------------------------------------------
  -- チャンク単位で実行
  -- --------------------------------------------------------------------------
  WHILE chunk_start < window_end DO
    SET chunk_end = LEAST(
      TIMESTAMP_ADD(chunk_start, INTERVAL load_chunk_days DAY),
      window_end
    );

    EXECUTE IMMEDIATE merge_sql
    USING
      chunk_start AS window_start,
      chunk_end AS window_end,
      collected_job_types AS collected_job_types,
      executor_label_key AS executor_label_key,
      @@location AS job_region,
      normalizer_version AS normalizer_version;

    SET chunk_count = chunk_count + 1;
    SET chunk_start = chunk_end;
  END WHILE;

  -- --------------------------------------------------------------------------
  -- 取り込み結果
  -- --------------------------------------------------------------------------
  EXECUTE IMMEDIATE FORMAT(r"""
    SELECT
      'bqc load completed' AS status,
      COUNT(*)                    AS total_rows,
      MIN(creation_date)          AS min_creation_date,
      MAX(creation_date)          AS max_creation_date,
      COUNT(DISTINCT normalized_fingerprint) AS distinct_fingerprints,
      COUNTIF(executor_source = 'LABEL')     AS rows_identified_by_label,
      COUNTIF(executor_source = 'USER_EMAIL') AS rows_fallen_back_to_user_email,
      SAFE_DIVIDE(COUNTIF(executor_source = 'LABEL'), COUNT(*)) AS label_coverage
    FROM `%s`
  """, job_cost_fqn);
END;
