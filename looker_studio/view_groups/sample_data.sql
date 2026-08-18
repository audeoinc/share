-- =====================================================================
-- View グループ比較の検証用サンプル
--
-- suffix = {ab, cd, ef} x {jp, us, uk} の 4 文字（9 通り）
--   前 2 桁 … SQL ロジックの系統。これがグループを決める
--   後 2 桁 … 国。参照先のデータセットとテーブル名が変わる
--
-- 期待するグループ分け:
--   ab: abjp, abus, abuk
--   cd: cdjp, cdus, cduk
--   ef: efjp, efus, efuk
--
-- 国ごとにソース データセットが変わる（suffix 文字列と一致しない差）:
--   jp -> sample_src_apac
--   us -> sample_src_amer
--   uk -> sample_src_emea
--
-- PROJECT は自分のプロジェクト ID に置換すること。
-- 片付けは sample_teardown.sql。
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. データセット
-- ---------------------------------------------------------------------
CREATE SCHEMA IF NOT EXISTS `PROJECT.sample_mart` OPTIONS (location = 'asia-northeast1');
CREATE SCHEMA IF NOT EXISTS `PROJECT.sample_src_apac` OPTIONS (location = 'asia-northeast1');
CREATE SCHEMA IF NOT EXISTS `PROJECT.sample_src_amer` OPTIONS (location = 'asia-northeast1');
CREATE SCHEMA IF NOT EXISTS `PROJECT.sample_src_emea` OPTIONS (location = 'asia-northeast1');

-- ---------------------------------------------------------------------
-- 2. ソース テーブル
-- ---------------------------------------------------------------------
CREATE OR REPLACE TABLE `PROJECT.sample_src_apac.orders_abjp` AS
SELECT * FROM UNNEST([
  STRUCT(1 AS order_id, 101 AS customer_id, DATE '2025-03-01' AS order_date,
         1000.0 AS amount, 'JPY' AS currency, 'north' AS region, 'CONFIRMED' AS status),
  STRUCT(2, 102, DATE '2025-03-02', 2500.0, 'JPY', 'south', 'CONFIRMED'),
  STRUCT(3, 101, DATE '2025-03-02', 1750.0, 'JPY', 'north', 'PENDING')
]);

CREATE OR REPLACE TABLE `PROJECT.sample_src_amer.orders_abus` AS
SELECT * FROM UNNEST([
  STRUCT(1 AS order_id, 101 AS customer_id, DATE '2025-03-01' AS order_date,
         1000.0 AS amount, 'USD' AS currency, 'north' AS region, 'CONFIRMED' AS status),
  STRUCT(2, 102, DATE '2025-03-02', 2500.0, 'USD', 'south', 'CONFIRMED'),
  STRUCT(3, 101, DATE '2025-03-02', 1750.0, 'USD', 'north', 'PENDING')
]);

CREATE OR REPLACE TABLE `PROJECT.sample_src_emea.orders_abuk` AS
SELECT * FROM UNNEST([
  STRUCT(1 AS order_id, 101 AS customer_id, DATE '2025-03-01' AS order_date,
         1000.0 AS amount, 'GBP' AS currency, 'north' AS region, 'CONFIRMED' AS status),
  STRUCT(2, 102, DATE '2025-03-02', 2500.0, 'GBP', 'south', 'CONFIRMED'),
  STRUCT(3, 101, DATE '2025-03-02', 1750.0, 'GBP', 'north', 'PENDING')
]);

CREATE OR REPLACE TABLE `PROJECT.sample_src_apac.orders_cdjp` AS
SELECT * FROM UNNEST([
  STRUCT(1 AS order_id, 101 AS customer_id, DATE '2025-03-01' AS order_date,
         1000.0 AS amount, 'JPY' AS currency, 'north' AS region, 'CONFIRMED' AS status),
  STRUCT(2, 102, DATE '2025-03-02', 2500.0, 'JPY', 'south', 'CONFIRMED'),
  STRUCT(3, 101, DATE '2025-03-02', 1750.0, 'JPY', 'north', 'PENDING')
]);

CREATE OR REPLACE TABLE `PROJECT.sample_src_amer.orders_cdus` AS
SELECT * FROM UNNEST([
  STRUCT(1 AS order_id, 101 AS customer_id, DATE '2025-03-01' AS order_date,
         1000.0 AS amount, 'USD' AS currency, 'north' AS region, 'CONFIRMED' AS status),
  STRUCT(2, 102, DATE '2025-03-02', 2500.0, 'USD', 'south', 'CONFIRMED'),
  STRUCT(3, 101, DATE '2025-03-02', 1750.0, 'USD', 'north', 'PENDING')
]);

CREATE OR REPLACE TABLE `PROJECT.sample_src_emea.orders_cduk` AS
SELECT * FROM UNNEST([
  STRUCT(1 AS order_id, 101 AS customer_id, DATE '2025-03-01' AS order_date,
         1000.0 AS amount, 'GBP' AS currency, 'north' AS region, 'CONFIRMED' AS status),
  STRUCT(2, 102, DATE '2025-03-02', 2500.0, 'GBP', 'south', 'CONFIRMED'),
  STRUCT(3, 101, DATE '2025-03-02', 1750.0, 'GBP', 'north', 'PENDING')
]);

CREATE OR REPLACE TABLE `PROJECT.sample_src_apac.orders_efjp` AS
SELECT * FROM UNNEST([
  STRUCT(1 AS order_id, 101 AS customer_id, DATE '2025-03-01' AS order_date,
         1000.0 AS amount, 'JPY' AS currency, 'north' AS region, 'CONFIRMED' AS status),
  STRUCT(2, 102, DATE '2025-03-02', 2500.0, 'JPY', 'south', 'CONFIRMED'),
  STRUCT(3, 101, DATE '2025-03-02', 1750.0, 'JPY', 'north', 'PENDING')
]);

CREATE OR REPLACE TABLE `PROJECT.sample_src_amer.orders_efus` AS
SELECT * FROM UNNEST([
  STRUCT(1 AS order_id, 101 AS customer_id, DATE '2025-03-01' AS order_date,
         1000.0 AS amount, 'USD' AS currency, 'north' AS region, 'CONFIRMED' AS status),
  STRUCT(2, 102, DATE '2025-03-02', 2500.0, 'USD', 'south', 'CONFIRMED'),
  STRUCT(3, 101, DATE '2025-03-02', 1750.0, 'USD', 'north', 'PENDING')
]);

CREATE OR REPLACE TABLE `PROJECT.sample_src_emea.orders_efuk` AS
SELECT * FROM UNNEST([
  STRUCT(1 AS order_id, 101 AS customer_id, DATE '2025-03-01' AS order_date,
         1000.0 AS amount, 'GBP' AS currency, 'north' AS region, 'CONFIRMED' AS status),
  STRUCT(2, 102, DATE '2025-03-02', 2500.0, 'GBP', 'south', 'CONFIRMED'),
  STRUCT(3, 101, DATE '2025-03-02', 1750.0, 'GBP', 'north', 'PENDING')
]);

CREATE OR REPLACE TABLE `PROJECT.sample_src_apac.customers_abjp` AS
SELECT * FROM UNNEST([
  STRUCT(101 AS customer_id, 'north' AS region),
  STRUCT(102, 'south')
]);

CREATE OR REPLACE TABLE `PROJECT.sample_src_amer.customers_abus` AS
SELECT * FROM UNNEST([
  STRUCT(101 AS customer_id, 'north' AS region),
  STRUCT(102, 'south')
]);

CREATE OR REPLACE TABLE `PROJECT.sample_src_emea.customers_abuk` AS
SELECT * FROM UNNEST([
  STRUCT(101 AS customer_id, 'north' AS region),
  STRUCT(102, 'south')
]);

CREATE OR REPLACE TABLE `PROJECT.sample_src_apac.customers_cdjp` AS
SELECT * FROM UNNEST([
  STRUCT(101 AS customer_id, 'north' AS region),
  STRUCT(102, 'south')
]);

CREATE OR REPLACE TABLE `PROJECT.sample_src_amer.customers_cdus` AS
SELECT * FROM UNNEST([
  STRUCT(101 AS customer_id, 'north' AS region),
  STRUCT(102, 'south')
]);

CREATE OR REPLACE TABLE `PROJECT.sample_src_emea.customers_cduk` AS
SELECT * FROM UNNEST([
  STRUCT(101 AS customer_id, 'north' AS region),
  STRUCT(102, 'south')
]);

CREATE OR REPLACE TABLE `PROJECT.sample_src_apac.customers_efjp` AS
SELECT * FROM UNNEST([
  STRUCT(101 AS customer_id, 'north' AS region),
  STRUCT(102, 'south')
]);

CREATE OR REPLACE TABLE `PROJECT.sample_src_amer.customers_efus` AS
SELECT * FROM UNNEST([
  STRUCT(101 AS customer_id, 'north' AS region),
  STRUCT(102, 'south')
]);

CREATE OR REPLACE TABLE `PROJECT.sample_src_emea.customers_efuk` AS
SELECT * FROM UNNEST([
  STRUCT(101 AS customer_id, 'north' AS region),
  STRUCT(102, 'south')
]);

-- ---------------------------------------------------------------------
-- 3. View（9 本 / ロジックは 3 系統）
-- ---------------------------------------------------------------------
-- ---- ab 系 ----
CREATE OR REPLACE VIEW `PROJECT.sample_mart.v_daily_sales_abjp` AS
SELECT
  o.order_date,
  o.region,
  COUNT(DISTINCT o.order_id) AS order_count,
  SUM(o.amount) AS gross_amount
FROM `PROJECT.sample_src_apac.orders_abjp` AS o
WHERE o.order_date >= DATE '2025-01-01'
GROUP BY o.order_date, o.region;

CREATE OR REPLACE VIEW `PROJECT.sample_mart.v_daily_sales_abus` AS
SELECT
  o.order_date,
  o.region,
  COUNT(DISTINCT o.order_id) AS order_count,
  SUM(o.amount) AS gross_amount
FROM `PROJECT.sample_src_amer.orders_abus` AS o
WHERE o.order_date >= DATE '2025-01-01'
GROUP BY o.order_date, o.region;

CREATE OR REPLACE VIEW `PROJECT.sample_mart.v_daily_sales_abuk` AS
SELECT
  o.order_date,
  o.region,
  COUNT(DISTINCT o.order_id) AS order_count,
  SUM(o.amount) AS gross_amount
FROM `PROJECT.sample_src_emea.orders_abuk` AS o
WHERE o.order_date >= DATE '2025-01-01'
GROUP BY o.order_date, o.region;

-- ---- cd 系 ----
CREATE OR REPLACE VIEW `PROJECT.sample_mart.v_daily_sales_cdjp` AS
SELECT
  o.order_date,
  c.region,
  COUNT(DISTINCT o.order_id) AS order_count,
  SUM(o.amount) AS gross_amount
FROM `PROJECT.sample_src_apac.orders_cdjp` AS o
LEFT JOIN `PROJECT.sample_src_apac.customers_cdjp` AS c
  ON o.customer_id = c.customer_id
WHERE o.order_date >= DATE '2025-01-01'
GROUP BY o.order_date, c.region;

CREATE OR REPLACE VIEW `PROJECT.sample_mart.v_daily_sales_cdus` AS
SELECT
  o.order_date,
  c.region,
  COUNT(DISTINCT o.order_id) AS order_count,
  SUM(o.amount) AS gross_amount
FROM `PROJECT.sample_src_amer.orders_cdus` AS o
LEFT JOIN `PROJECT.sample_src_amer.customers_cdus` AS c
  ON o.customer_id = c.customer_id
WHERE o.order_date >= DATE '2025-01-01'
GROUP BY o.order_date, c.region;

CREATE OR REPLACE VIEW `PROJECT.sample_mart.v_daily_sales_cduk` AS
SELECT
  o.order_date,
  c.region,
  COUNT(DISTINCT o.order_id) AS order_count,
  SUM(o.amount) AS gross_amount
FROM `PROJECT.sample_src_emea.orders_cduk` AS o
LEFT JOIN `PROJECT.sample_src_emea.customers_cduk` AS c
  ON o.customer_id = c.customer_id
WHERE o.order_date >= DATE '2025-01-01'
GROUP BY o.order_date, c.region;

-- ---- ef 系 ----
CREATE OR REPLACE VIEW `PROJECT.sample_mart.v_daily_sales_efjp` AS
SELECT
  o.order_date,
  o.region,
  o.currency,
  COUNT(DISTINCT o.order_id) AS order_count,
  SUM(o.amount) AS gross_amount,
  SUM(o.amount) / NULLIF(COUNT(DISTINCT o.order_id), 0) AS avg_amount
FROM `PROJECT.sample_src_apac.orders_efjp` AS o
WHERE o.order_date >= DATE '2025-01-01'
GROUP BY o.order_date, o.region, o.currency;

CREATE OR REPLACE VIEW `PROJECT.sample_mart.v_daily_sales_efus` AS
SELECT
  o.order_date,
  o.region,
  o.currency,
  COUNT(DISTINCT o.order_id) AS order_count,
  SUM(o.amount) AS gross_amount,
  SUM(o.amount) / NULLIF(COUNT(DISTINCT o.order_id), 0) AS avg_amount
FROM `PROJECT.sample_src_amer.orders_efus` AS o
WHERE o.order_date >= DATE '2025-01-01'
GROUP BY o.order_date, o.region, o.currency;

CREATE OR REPLACE VIEW `PROJECT.sample_mart.v_daily_sales_efuk` AS
SELECT
  o.order_date,
  o.region,
  o.currency,
  COUNT(DISTINCT o.order_id) AS order_count,
  SUM(o.amount) AS gross_amount,
  SUM(o.amount) / NULLIF(COUNT(DISTINCT o.order_id), 0) AS avg_amount
FROM `PROJECT.sample_src_emea.orders_efuk` AS o
WHERE o.order_date >= DATE '2025-01-01'
GROUP BY o.order_date, o.region, o.currency;

-- ---------------------------------------------------------------------
-- 4. 確認: INFORMATION_SCHEMA から (view_name, ddl) を取る
--    アナライザにはこの結果を渡す
-- ---------------------------------------------------------------------
-- SELECT table_name AS view_name, ddl
-- FROM `PROJECT.sample_mart.INFORMATION_SCHEMA.TABLES`
-- WHERE table_type = 'VIEW'
-- ORDER BY table_name;
