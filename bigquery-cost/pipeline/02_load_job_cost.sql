-- ============================================================================
-- 02_load_job_cost.sql
-- INFORMATION_SCHEMA.JOBS -> bqc_t_job_cost の増分取り込み
-- ============================================================================
-- 日次で実行する（スケジュールドクエリ推奨）。初回は自動的に
-- initial_lookback_days（既定 120 日）を遡ってバックフィルし、2 回目以降は
-- incremental_lookback_days（既定 3 日）だけを読み直す。対象時間帯を削除してから
-- 入れ直すので、何度流しても二重登録にならず、正規化ロジックを変えた場合も
-- 対象期間ぶんは次の実行で作り直される。
--
-- 設計上のポイント:
--   * 親 SCRIPT と子文の両方を取り込む。二重計上の切り分けはここではせず、
--     bqc_vw_t_job_cost_resolved の is_cost_countable が担当する
--     （チャンク分割スキャンだと親子が別チャンクに落ちて判定できないため）。
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
  --
  -- Variable notes (keyed by name):
  --   project_token_pattern / repository_dataset / table_name_* / udf_name_*
  --     01 と必ず同じ値にすること。名前が食い違うと別の表を作りに行く。
  --     食い違うと Not found: Function になる。
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

  -- --------------------------------------------------------------------------
  -- [C] DERIVED / INTERNAL -- from [A]; DO NOT edit
  -- --------------------------------------------------------------------------
  DECLARE repository_project_id STRING DEFAULT NULL;
  DECLARE project_token STRING;
  DECLARE job_cost_fqn STRING;
  DECLARE job_cost_source_fqn STRING;
  DECLARE delete_sql STRING;
  DECLARE insert_sql STRING;
  DECLARE inserted_rows INT64 DEFAULT 0;
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

  SET project_token =
    COALESCE(REGEXP_EXTRACT(default_project_id, project_token_pattern), '');
  SET repository_dataset = REPLACE(repository_dataset, '{project_token}', project_token);
  SET table_name_prefix = REPLACE(table_name_prefix, '{project_token}', project_token);
  SET table_name_suffix = REPLACE(table_name_suffix, '{project_token}', project_token);

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
  SET job_cost_source_fqn = FORMAT(
    '%s.%s.%s',
    repository_project_id,
    repository_dataset,
    table_name_prefix || 'bqc_' || 'vw_t_' || 'job_cost_source' || table_name_suffix
  );

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
  -- 取り込みテンプレート（チャンクごとに値だけ差し替えて実行する）
  -- --------------------------------------------------------------------------
  -- 対象時間帯をいったん削除してから入れ直す（re-derive）。MERGE の
  -- INSERT のみでは既存行が二度と更新されないため、正規化 UDF や取り込み条件を
  -- 変えても取り込み済みの行に反映されず、01 を破壊的に流し直すしかなかった。
  -- 削除して入れ直せば、次の 02 で対象期間ぶんが自動的に作り直される。
  --
  -- DELETE の範囲は INSERT の抽出条件と同じ creation_time の区間で厳密に決める。
  -- creation_date（パーティションキー）の述語も AND で足しているが、これは
  -- プルーニング用の冗長条件で、範囲を広げも狭めもしない。
  --
  -- DELETE と INSERT は別の文なので、その間で落ちるとその時間帯が一時的に
  -- 欠ける。ただし 02 は再実行で必ず復旧し、03 は「job_cost にあって
  -- daily_cost に無い日」まで遡る自己修復型なので、次の実行で自然に直る。
  SET delete_sql = FORMAT(r"""
    DELETE FROM `%s`
    WHERE creation_time >= @window_start
      AND creation_time <  @window_end
      AND creation_date >= DATE(@window_start)
      AND creation_date <= DATE(@window_end)
  """, job_cost_fqn);

  -- 加工は bqc_vw_t_job_cost_source（01 が作る）に寄せてあるので、ここは
  -- 期間を切り出して入れるだけ。列順の一致はビュー側で担保している。
  SET insert_sql = FORMAT(r"""
    INSERT INTO `%s`
    SELECT *
    FROM `%s`
    WHERE creation_time >= @window_start
      AND creation_time <  @window_end
      AND job_type IN UNNEST(@collected_job_types)
  """, job_cost_fqn, job_cost_source_fqn);

  -- --------------------------------------------------------------------------
  -- チャンク単位で実行
  -- --------------------------------------------------------------------------
  WHILE chunk_start < window_end DO
    SET chunk_end = LEAST(
      TIMESTAMP_ADD(chunk_start, INTERVAL load_chunk_days DAY),
      window_end
    );

    EXECUTE IMMEDIATE delete_sql
    USING chunk_start AS window_start, chunk_end AS window_end;

    EXECUTE IMMEDIATE insert_sql
    USING
      chunk_start AS window_start,
      chunk_end AS window_end,
      collected_job_types AS collected_job_types;

    SET inserted_rows = inserted_rows + @@row_count;
    SET chunk_count = chunk_count + 1;
    SET chunk_start = chunk_end;
  END WHILE;

  -- --------------------------------------------------------------------------
  -- 取り込み結果
  -- --------------------------------------------------------------------------
  EXECUTE IMMEDIATE FORMAT(r"""
    SELECT
      'bqc load completed' AS status,
      @inserted_rows              AS rows_inserted_this_run,
      @job_cost_fqn               AS job_cost_table,
      @job_cost_source_fqn        AS job_cost_source_view,
      COUNT(*)                    AS total_rows,
      MIN(creation_date)          AS min_creation_date,
      MAX(creation_date)          AS max_creation_date,
      COUNT(DISTINCT normalized_fingerprint) AS distinct_fingerprints,
      COUNTIF(executor_source = 'LABEL')     AS rows_identified_by_label,
      COUNTIF(executor_source = 'USER_EMAIL') AS rows_fallen_back_to_user_email,
      SAFE_DIVIDE(COUNTIF(executor_source = 'LABEL'), COUNT(*)) AS label_coverage
    FROM `%s`
  """, job_cost_fqn)
  USING job_cost_fqn AS job_cost_fqn, job_cost_source_fqn AS job_cost_source_fqn,
        inserted_rows AS inserted_rows;
END;
