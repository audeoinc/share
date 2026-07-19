-- BigQuery用: Viewを依存関係の順に作成する一括実行SQL
-- 実行順: base -> summary -> segment_rank -> region_dashboard -> pivot -> pivot_4layer

CREATE OR REPLACE VIEW `audeodb.sample_ds.v_ec_base_purchase` AS
SELECT
  h.order_id,
  h.customer_id,
  c.customer_name,
  c.region,
  c.customer_segment,
  h.purchase_date,
  ROUND(h.unit_price * h.quantity * (1 - h.discount_rate), 0) AS sales_amount,
  p.product_name,
  p.category AS product_category
FROM `audeodb.sample_ds.customer_purchase_history` AS h
JOIN `audeodb.sample_ds.customer_master` AS c
  ON h.customer_id = c.customer_id
JOIN `audeodb.sample_ds.product_master` AS p
  ON h.product_id = p.product_id;

CREATE OR REPLACE VIEW `audeodb.sample_ds.v_ec_customer_summary` AS
SELECT
  base.customer_id,
  base.customer_name,
  base.region,
  base.customer_segment,
  COUNT(DISTINCT base.order_id) AS total_orders,
  SUM(base.sales_amount) AS total_sales,
  ROUND(AVG(base.sales_amount), 0) AS avg_order_value,
  MAX(base.sales_amount) AS max_order_amount,
  MIN(base.purchase_date) AS first_purchase_date,
  MAX(base.purchase_date) AS last_purchase_date,
  ARRAY_TO_STRING(
    ARRAY(
      SELECT DISTINCT category
      FROM UNNEST(
        ARRAY(
          SELECT DISTINCT b2.product_category
          FROM `audeodb.sample_ds.v_ec_base_purchase` AS b2
          WHERE b2.customer_id = base.customer_id
        )
      ) AS category
    ),
    ', '
  ) AS categories_bought
FROM `audeodb.sample_ds.v_ec_base_purchase` AS base
GROUP BY
  base.customer_id,
  base.customer_name,
  base.region,
  base.customer_segment;

CREATE OR REPLACE VIEW `audeodb.sample_ds.v_ec_customer_segment_rank` AS
SELECT
  summary.customer_id,
  summary.customer_name,
  summary.region,
  summary.customer_segment,
  summary.total_orders,
  summary.total_sales,
  summary.avg_order_value,
  summary.max_order_amount,
  summary.first_purchase_date,
  summary.last_purchase_date,
  summary.categories_bought,
  CASE
    WHEN summary.total_sales >= 200000 THEN 'VIP'
    WHEN summary.total_sales >= 100000 THEN '高額顧客'
    WHEN summary.total_orders >= 3 THEN 'リピート顧客'
    ELSE '新規顧客'
  END AS customer_tier,
  RANK() OVER (PARTITION BY summary.region ORDER BY summary.total_sales DESC) AS rank_in_region,
  SUM(summary.total_sales) OVER (PARTITION BY summary.region) AS region_sales_total,
  ROUND(
    (
      SELECT AVG(s.total_sales)
      FROM `audeodb.sample_ds.v_ec_customer_summary` AS s
      WHERE s.region = summary.region
    ),
    0
  ) AS avg_sales_by_region
FROM `audeodb.sample_ds.v_ec_customer_summary` AS summary;

CREATE OR REPLACE VIEW `audeodb.sample_ds.v_ec_region_dashboard` AS
SELECT
  rank_view.customer_id,
  rank_view.customer_name,
  rank_view.region,
  rank_view.customer_segment,
  rank_view.customer_tier,
  rank_view.total_orders,
  rank_view.total_sales,
  rank_view.avg_order_value,
  rank_view.categories_bought,
  rank_view.rank_in_region,
  rank_view.region_sales_total,
  ROUND(rank_view.total_sales / NULLIF(rank_view.region_sales_total, 0) * 100, 1) AS share_of_region_sales_pct,
  CASE
    WHEN ROUND(rank_view.total_sales / NULLIF(rank_view.region_sales_total, 0) * 100, 1) >= 20 THEN '地域の主要顧客'
    WHEN rank_view.customer_tier = 'VIP' THEN 'VIP顧客'
    ELSE '一般顧客'
  END AS customer_role
FROM `audeodb.sample_ds.v_ec_customer_segment_rank` AS rank_view;

CREATE OR REPLACE VIEW `audeodb.sample_ds.v_ec_customer_purchase_pivot` AS
WITH base AS (
  SELECT
    h.order_id,
    h.customer_id,
    c.customer_name,
    c.region,
    c.customer_segment,
    h.purchase_date,
    ROUND(h.unit_price * h.quantity * (1 - h.discount_rate), 0) AS sales_amount,
    p.category AS product_category
  FROM `audeodb.sample_ds.customer_purchase_history` AS h
  JOIN `audeodb.sample_ds.customer_master` AS c
    ON h.customer_id = c.customer_id
  JOIN `audeodb.sample_ds.product_master` AS p
    ON h.product_id = p.product_id
)
SELECT
  customer_id,
  customer_name,
  region,
  customer_segment,
  SUM(CASE WHEN product_category = 'PC' THEN sales_amount ELSE 0 END) AS sales_pc,
  SUM(CASE WHEN product_category = 'AV' THEN sales_amount ELSE 0 END) AS sales_av,
  SUM(CASE WHEN product_category = '家電' THEN sales_amount ELSE 0 END) AS sales_home_appliance,
  SUM(CASE WHEN product_category = 'ウェアラブル' THEN sales_amount ELSE 0 END) AS sales_wearable,
  SUM(sales_amount) AS total_sales,
  COUNT(DISTINCT order_id) AS total_orders,
  ROUND(AVG(sales_amount), 0) AS avg_order_value
FROM base
GROUP BY
  customer_id,
  customer_name,
  region,
  customer_segment
QUALIFY ROW_NUMBER() OVER (PARTITION BY region ORDER BY total_sales DESC) <= 3;

CREATE OR REPLACE VIEW `audeodb.sample_ds.v_ec_customer_purchase_pivot_4layer` AS
WITH base AS (
  SELECT
    h.order_id,
    h.customer_id,
    c.customer_name,
    c.region,
    c.customer_segment,
    h.purchase_date,
    ROUND(h.unit_price * h.quantity * (1 - h.discount_rate), 0) AS sales_amount,
    p.category AS product_category
  FROM `audeodb.sample_ds.customer_purchase_history` AS h
  JOIN `audeodb.sample_ds.customer_master` AS c
    ON h.customer_id = c.customer_id
  JOIN `audeodb.sample_ds.product_master` AS p
    ON h.product_id = p.product_id
),
customer_summary AS (
  SELECT
    customer_id,
    customer_name,
    region,
    customer_segment,
    SUM(sales_amount) AS total_sales,
    COUNT(DISTINCT order_id) AS total_orders,
    ROUND(AVG(sales_amount), 0) AS avg_order_value,
    ARRAY_TO_STRING(
      ARRAY(
        SELECT DISTINCT product_category
        FROM UNNEST(
          ARRAY(
            SELECT DISTINCT b2.product_category
            FROM base AS b2
            WHERE b2.customer_id = base.customer_id
          )
        ) AS product_category
      ),
      ', '
    ) AS categories_bought
  FROM base
  GROUP BY
    customer_id,
    customer_name,
    region,
    customer_segment
),
pivoted AS (
  SELECT
    customer_id,
    customer_name,
    region,
    customer_segment,
    total_sales,
    total_orders,
    avg_order_value,
    categories_bought,
    SUM(CASE WHEN product_category = 'PC' THEN sales_amount ELSE 0 END) AS sales_pc,
    SUM(CASE WHEN product_category = 'AV' THEN sales_amount ELSE 0 END) AS sales_av,
    SUM(CASE WHEN product_category = '家電' THEN sales_amount ELSE 0 END) AS sales_home_appliance,
    SUM(CASE WHEN product_category = 'ウェアラブル' THEN sales_amount ELSE 0 END) AS sales_wearable
  FROM (
    SELECT
      base.customer_id,
      base.customer_name,
      base.region,
      base.customer_segment,
      base.sales_amount,
      base.product_category,
      customer_summary.total_sales,
      customer_summary.total_orders,
      customer_summary.avg_order_value,
      customer_summary.categories_bought
    FROM base
    JOIN customer_summary
      ON base.customer_id = customer_summary.customer_id
  )
  GROUP BY
    customer_id,
    customer_name,
    region,
    customer_segment,
    total_sales,
    total_orders,
    avg_order_value,
    categories_bought
)
SELECT
  customer_id,
  customer_name,
  region,
  customer_segment,
  total_sales,
  total_orders,
  avg_order_value,
  categories_bought,
  sales_pc,
  sales_av,
  sales_home_appliance,
  sales_wearable,
  CASE
    WHEN total_sales >= 200000 THEN 'VIP'
    WHEN total_sales >= 100000 THEN '高額顧客'
    WHEN total_orders >= 3 THEN 'リピート顧客'
    ELSE '新規顧客'
  END AS customer_tier,
  ROUND(total_sales / NULLIF(SUM(total_sales) OVER (PARTITION BY region), 0) * 100, 1) AS share_of_region_sales_pct
FROM pivoted
QUALIFY ROW_NUMBER() OVER (PARTITION BY region ORDER BY total_sales DESC) <= 3;

-- UNION を使ったトランザクション統合ビューを追加
CREATE OR REPLACE VIEW `audeodb.sample_ds.v_ec_union_transactions` AS
WITH base AS (
  SELECT
    h.order_id,
    h.customer_id,
    c.customer_name,
    c.region,
    h.purchase_date,
    ROUND(h.unit_price * h.quantity * (1 - h.discount_rate), 0) AS sales_amount,
    p.category AS product_category,
    h.order_status
  FROM `audeodb.sample_ds.customer_purchase_history` AS h
  JOIN `audeodb.sample_ds.customer_master` AS c
    ON h.customer_id = c.customer_id
  JOIN `audeodb.sample_ds.product_master` AS p
    ON h.product_id = p.product_id
)
SELECT
  order_id,
  customer_id,
  customer_name,
  region,
  purchase_date,
  sales_amount AS amount,
  product_category,
  'sale' AS txn_type
FROM base
WHERE order_status = 'completed'
UNION ALL
SELECT
  order_id,
  customer_id,
  customer_name,
  region,
  purchase_date,
  -sales_amount AS amount,
  product_category,
  'refund' AS txn_type
FROM base
WHERE LOWER(order_status) IN ('refunded','refund','returned') OR order_status = 'refunded';

-- 複雑な UNION/UNION ALL/UNION DISTINCT を包含した View を追加
CREATE OR REPLACE VIEW `audeodb.sample_ds.v_ec_complex_union` AS
WITH RECURSIVE
completed AS (
  SELECT
    h.order_id,
    h.customer_id,
    c.customer_name,
    c.region,
    c.customer_segment,
    h.product_id,
    p.product_name,
    p.category AS product_category,
    h.purchase_date,
    ROUND(h.unit_price * h.quantity * (1 - h.discount_rate), 0) AS sales_amount,
    h.quantity,
    h.payment_method,
    h.channel,
    h.order_status
  FROM `audeodb.sample_ds.customer_purchase_history` AS h
  JOIN `audeodb.sample_ds.customer_master` AS c
    ON h.customer_id = c.customer_id
  JOIN `audeodb.sample_ds.product_master` AS p
    ON h.product_id = p.product_id
  WHERE LOWER(h.order_status) = 'completed'
),
online AS (
  SELECT * FROM completed WHERE LOWER(channel) = 'online'
),
store AS (
  SELECT * FROM completed WHERE LOWER(channel) IN ('store','store')
),
refunds AS (
  SELECT
    h.order_id,
    h.customer_id,
    c.customer_name,
    c.customer_segment,
    c.region,
    h.purchase_date,
    -ROUND(h.unit_price * h.quantity * (1 - h.discount_rate), 0) AS sales_amount,
    p.category AS product_category,
    'refund' AS txn_type
  FROM `audeodb.sample_ds.customer_purchase_history` AS h
  JOIN `audeodb.sample_ds.customer_master` AS c
    ON h.customer_id = c.customer_id
  JOIN `audeodb.sample_ds.product_master` AS p
    ON h.product_id = p.product_id
  WHERE LOWER(h.order_status) IN ('refunded','returned')
),
online_store_union_distinct AS (
  SELECT order_id, customer_id, customer_name, customer_segment, region, product_category, purchase_date, sales_amount, 'sale_online' AS txn_type
  FROM online
  UNION DISTINCT
  SELECT order_id, customer_id, customer_name, customer_segment, region, product_category, purchase_date, sales_amount, 'sale_store' AS txn_type
  FROM store
),
all_txns AS (
  -- 明示的なカラムリストで UNION ALL を構成（SELECT * EXCEPT/REPLACE の競合を回避）
  SELECT order_id, customer_id, customer_name, customer_segment, region, product_category, purchase_date, sales_amount, txn_type
  FROM online_store_union_distinct
  UNION ALL
  SELECT order_id, customer_id, customer_name, customer_segment, region, product_category, purchase_date, sales_amount, txn_type
  FROM refunds
),
purchase_ranked AS (
  SELECT
    h.order_id,
    h.customer_id,
    h.purchase_date,
    ROW_NUMBER() OVER (PARTITION BY h.customer_id ORDER BY h.purchase_date) AS seq
  FROM `audeodb.sample_ds.customer_purchase_history` AS h
  WHERE LOWER(h.order_status) = 'completed'
),
order_path AS (
  SELECT
    pr.customer_id,
    pr.order_id,
    pr.purchase_date,
    pr.seq,
    ARRAY<STRUCT<order_id STRING, purchase_date DATE>>[STRUCT(pr.order_id, pr.purchase_date)] AS order_chain
  FROM purchase_ranked AS pr
  WHERE pr.seq = 1
  UNION ALL
  SELECT
    pr.customer_id,
    pr.order_id,
    pr.purchase_date,
    pr.seq,
    ARRAY_CONCAT(order_path.order_chain, [STRUCT(pr.order_id, pr.purchase_date)])
  FROM order_path
  JOIN purchase_ranked AS pr
    ON pr.customer_id = order_path.customer_id AND pr.seq = order_path.seq + 1
  WHERE order_path.seq < 3
),
purchase_paths AS (
  SELECT customer_id, order_chain, seq FROM order_path
),
structured_txns AS (
  SELECT *, (
    SELECT AS STRUCT
      order_id AS detail_order_id,
      product_category AS detail_category,
      sales_amount AS detail_amount,
      STRUCT(txn_type AS type, purchase_date AS date) AS txn_header
  ) AS txn_info
  FROM all_txns
),
pure_struct_txns AS (
  SELECT * EXCEPT(order_id, product_category, sales_amount)
  FROM structured_txns
),
pivoted_by_category AS (
  SELECT * FROM (
    SELECT customer_id, product_category, sales_amount
    FROM all_txns
  )
  PIVOT (
    SUM(sales_amount) FOR product_category IN ('PC' AS pc_sales, 'AV' AS av_sales, '家電' AS home_sales, 'ウェアラブル' AS wearable_sales)
  )
),
unpivoted_categories AS (
  SELECT * FROM (
    SELECT customer_id, pc_sales, av_sales, home_sales, wearable_sales
    FROM pivoted_by_category
  )
  UNPIVOT (
    amount FOR category IN (pc_sales AS 'PC', av_sales AS 'AV', home_sales AS '家電', wearable_sales AS 'ウェアラブル')
  )
),
category_structs AS (
  SELECT
    customer_id,
    ARRAY_AGG(STRUCT(category, cnt AS cat_count) ORDER BY cnt DESC) AS category_stats
  FROM (
    SELECT customer_id, product_category AS category, COUNT(*) AS cnt
    FROM all_txns
    GROUP BY customer_id, product_category
  )
  GROUP BY customer_id
),
customer_order_structs AS (
  SELECT
    customer_id,
    ARRAY_AGG(
      STRUCT(
        order_id,
        product_category,
        sales_amount,
        STRUCT(txn_type AS type, purchase_date AS date) AS txn_header
      )
      ORDER BY purchase_date DESC
      LIMIT 3
    ) AS recent_order_chain
  FROM all_txns
  GROUP BY customer_id
),
recent_chain AS (
  SELECT
    customer_id,
    ARRAY_TO_STRING(
      ARRAY(
        SELECT CONCAT(order_id, '@', CAST(purchase_date AS STRING))
        FROM UNNEST(order_chain)
      ),
      ' > '
    ) AS recent_chain
  FROM purchase_paths
  WHERE seq = 3
),
purchase_events AS (
  SELECT
    c.customer_id,
    c.purchase_date,
    DATE_DIFF(
      c.purchase_date,
      LAG(c.purchase_date) OVER (PARTITION BY c.customer_id ORDER BY c.purchase_date),
      DAY
    ) AS days_since_prev
  FROM completed AS c
),
purchase_islands AS (
  SELECT
    customer_id,
    purchase_date,
    SUM(IF(days_since_prev IS NULL OR days_since_prev > 1, 1, 0)) OVER (
      PARTITION BY customer_id ORDER BY purchase_date
    ) AS island_id
  FROM purchase_events
),
island_summary AS (
  SELECT
    customer_id,
    island_id,
    MIN(purchase_date) AS island_start,
    MAX(purchase_date) AS island_end,
    COUNT(1) AS island_days
  FROM purchase_islands
  GROUP BY customer_id, island_id
),
customer_islands AS (
  SELECT
    customer_id,
    ARRAY_AGG(
      STRUCT(island_start, island_end, island_days)
      ORDER BY island_start
    ) AS purchase_islands
  FROM island_summary
  GROUP BY customer_id
),
customer_agg AS (
  SELECT
    t.customer_id,
    t.customer_name,
    t.region,
    t.customer_segment,
    COUNT(1) AS txn_count,
    SUM(t.txn_info.detail_amount) AS txn_total,
    ROUND(AVG(t.txn_info.detail_amount),0) AS txn_avg,
    MAX(t.purchase_date) AS last_purchase_date,
    MIN(t.purchase_date) AS first_purchase_date,
    -- 直近3件の購入金額の平均は後続の CTE `recent_avg` で結合して取得
    NULL AS avg_last_3_orders,
    COALESCE(
      ARRAY_TO_STRING(
        ARRAY(
          SELECT CONCAT(cs.category, ':', CAST(cs.cat_count AS STRING))
          FROM UNNEST(category_stats) AS cs
        ),
        ', '
      ),
      ''
    ) AS categories_bought
  FROM pure_struct_txns AS t
  LEFT JOIN category_structs AS c
    ON t.customer_id = c.customer_id
  GROUP BY t.customer_id, t.customer_name, t.region, t.customer_segment, c.category_stats
),
-- recent_avg: v_ec_union_transactions から顧客ごとの直近3件平均を計算
recent_avg AS (
  SELECT customer_id, ROUND(AVG(amount),0) AS avg_last_3_orders
  FROM (
    SELECT customer_id, amount, ROW_NUMBER() OVER (PARTITION BY customer_id ORDER BY purchase_date DESC) AS rn
    FROM `audeodb.sample_ds.v_ec_union_transactions`
  ) WHERE rn <= 3
  GROUP BY customer_id
),
customer_agg2 AS (
  SELECT
    ca.customer_id,
    ca.customer_name,
    ca.region,
    ca.customer_segment,
    ca.txn_count,
    ca.txn_total,
    ca.txn_avg,
    ca.last_purchase_date,
    ca.first_purchase_date,
    COALESCE(rr.avg_last_3_orders, 0) AS avg_last_3_orders,
    ca.categories_bought,
    co.recent_order_chain,
    COALESCE(ci.purchase_islands, []) AS purchase_islands
  FROM customer_agg AS ca
  LEFT JOIN recent_avg AS rr
    ON ca.customer_id = rr.customer_id
  LEFT JOIN customer_order_structs AS co
    ON ca.customer_id = co.customer_id
  LEFT JOIN customer_islands AS ci
    ON ca.customer_id = ci.customer_id
),
customer_windowed AS (
  SELECT
    ca2.*,
    RANK() OVER (PARTITION BY ca2.region ORDER BY ca2.txn_total DESC) AS rank_in_region,
    SUM(ca2.txn_total) OVER (PARTITION BY ca2.region) AS region_total_sales,
    ROUND(ca2.txn_total / NULLIF(SUM(ca2.txn_total) OVER (PARTITION BY ca2.region),0) * 100,1) AS pct_of_region
  FROM customer_agg2 AS ca2
)

SELECT * REPLACE(
  ROUND(txn_total * 1.1, 0) AS txn_total,
  CASE
    WHEN txn_total >= 200000 THEN '[VIP]'
    WHEN txn_total >= 100000 THEN '[Premium]'
    WHEN txn_count >= 5 THEN '[Loyal]'
    ELSE '[Standard]'
  END AS customer_class
) FROM (
  SELECT
    cw.customer_id,
    cw.customer_name,
    cw.region,
    cw.customer_segment,
    cw.txn_count,
    cw.txn_total,
    cw.txn_avg,
    cw.avg_last_3_orders,
    cw.categories_bought,
    cw.recent_order_chain,
    cw.purchase_islands,
    cw.rank_in_region,
    cw.region_total_sales,
    cw.pct_of_region,
    rc.recent_chain,
    CASE
      WHEN cw.txn_total >= 200000 THEN 'VIP'
      WHEN cw.txn_total >= 100000 THEN '高額顧客'
      WHEN cw.txn_count >= 5 THEN '頻繁購入者'
      ELSE '通常顧客'
    END AS customer_class
  FROM customer_windowed AS cw
  LEFT JOIN recent_chain AS rc
    ON cw.customer_id = rc.customer_id
)
WHERE TRUE
QUALIFY ROW_NUMBER() OVER (PARTITION BY region ORDER BY txn_total DESC) <= 5;
