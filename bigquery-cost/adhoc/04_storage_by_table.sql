-- 04: テーブル別のストレージ費用（アクティブ / 長期）
--     90日間更新されていないデータは自動で「長期保存」になり単価が半額になる。
--
-- 使い方: PROJECT / REGION を書き換えて実行（01 と同じ）
--
-- 注意:
--   - 単価は「論理バイト課金」か「物理バイト課金」かで変わる（データセット単位の設定）。
--     下は論理バイト課金の想定。物理課金なら active_physical_bytes / long_term_physical_bytes を使う。
--   - 無料枠: ストレージ 10 GiB/月

DECLARE usd_per_gib_active    FLOAT64 DEFAULT 0.020;  -- US マルチリージョンの参考値
DECLARE usd_per_gib_long_term FLOAT64 DEFAULT 0.010;  -- 同上（アクティブの半額）

SELECT
  table_schema AS dataset,
  table_name,
  ROUND(active_logical_bytes    / POW(1024, 3), 3) AS active_gib,
  ROUND(long_term_logical_bytes / POW(1024, 3), 3) AS long_term_gib,
  ROUND(
      active_logical_bytes    / POW(1024, 3) * usd_per_gib_active
    + long_term_logical_bytes / POW(1024, 3) * usd_per_gib_long_term
  , 4) AS est_usd_per_month,
  total_rows
FROM `audeodb.region-asia-northeast1`.INFORMATION_SCHEMA.TABLE_STORAGE
WHERE total_logical_bytes > 0
ORDER BY total_logical_bytes DESC;
