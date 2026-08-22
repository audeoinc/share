'use strict';
/**
 * 判定を痛めつけるための「できるだけ複雑な」View 1 本。
 *
 * 単純な SELECT だけだと、実体名の検出（FROM / JOIN の位置判定）が素通りして
 * しまう。実際の View に出てくる構文を一通り入れて、
 *   - 実体名を取りこぼしていないか（取りこぼすと誤って別グループに割れる）
 *   - 実体名でないものを拾っていないか（拾うと本物の差を見逃す）
 * を確かめる。
 *
 * 入っているもの:
 *   多段 CTE / CTE の相互参照 / UNNEST を伴うカンマ結合 / 名前付きウィンドウ /
 *   QUALIFY / LEFT JOIN … USING / スカラー サブクエリ / EXISTS 相関サブクエリ /
 *   CASE 式 / STRUCT / UNION ALL / バッククォートあり・なしの参照 / ORDER BY
 */

const TEMPLATE = `
WITH
base_orders AS (
  SELECT
    o.order_id,
    o.order_date,
    o.customer_id,
    o.tags,
    o.amount,
    CASE
      WHEN o.amount >= 10000 THEN 'LARGE'
      WHEN o.amount >= 1000  THEN 'MEDIUM'
      ELSE 'SMALL'
    END AS size_band
  FROM \`PRJ.mart_@S@.orders_@S@\` AS o
  WHERE o.order_date >= DATE '2025-01-01'
    AND o.status = 'CONFIRMED'
    AND EXISTS (
      SELECT 1
      FROM \`PRJ.mart_@S@.customers_@S@\` AS c
      WHERE c.customer_id = o.customer_id
        AND c.country = '@C@'
    )
),
tagged AS (
  SELECT
    b.order_id,
    b.order_date,
    b.customer_id,
    b.amount,
    b.size_band,
    tag
  FROM base_orders AS b, UNNEST(b.tags) AS tag
),
ranked AS (
  SELECT
    t.order_id,
    t.order_date,
    t.customer_id,
    t.amount,
    t.size_band,
    ROW_NUMBER() OVER w AS rn,
    SUM(t.amount) OVER w AS running_amount
  FROM tagged AS t
  WINDOW w AS (PARTITION BY t.customer_id ORDER BY t.order_date)
  QUALIFY rn <= 100
),
daily AS (
  SELECT
    r.order_date,
    r.size_band,
    COUNT(DISTINCT r.order_id) AS order_count,
    SUM(r.amount)              AS gross_amount,
    STRUCT(
      MIN(r.amount) AS min_amount,
      MAX(r.amount) AS max_amount
    ) AS amount_range
  FROM ranked AS r
  LEFT JOIN \`PRJ.ref_@S@.calendar_@S@\` AS cal USING (order_date)
  WHERE cal.is_business_day
  GROUP BY r.order_date, r.size_band
),
returns AS (
  SELECT
    rt.order_date,
    'RETURN' AS size_band,
    COUNT(*)       AS order_count,
    SUM(rt.amount) AS gross_amount,
    STRUCT(
      MIN(rt.amount) AS min_amount,
      MAX(rt.amount) AS max_amount
    ) AS amount_range
  FROM PRJ.mart_@S@.returns_@S@ AS rt
  GROUP BY rt.order_date
)
SELECT
  d.order_date,
  d.size_band,
  d.order_count,
  d.gross_amount,
  d.amount_range,
  SAFE_DIVIDE(d.gross_amount, d.order_count) AS avg_amount,
  (SELECT MAX(x.gross_amount) FROM daily AS x) AS peak_amount
FROM daily AS d
UNION ALL
SELECT
  n.order_date,
  n.size_band,
  n.order_count,
  n.gross_amount,
  n.amount_range,
  SAFE_DIVIDE(n.gross_amount, n.order_count) AS avg_amount,
  0 AS peak_amount
FROM returns AS n
ORDER BY order_date, size_band
`.trim();

/** この fixture が使う suffix の区分。 */
const COMPLEX_PARTS = [['ab', 'cd'], ['jp', 'us', 'uk']];

/** suffix と連動する国コード。リテラルにも suffix が効くことを見るため。 */
const COUNTRY = {
  abjp: 'JP', abus: 'US', abuk: 'UK',
  cdjp: 'JP', cdus: 'US', cduk: 'UK',
};

/** 1 本ぶんの SQL。mutate に関数を渡すと、そこだけ差を入れられる。 */
function complexSql(suffix, mutate) {
  const sql = TEMPLATE.split('@S@').join(suffix).split('@C@').join(COUNTRY[suffix]);
  return mutate ? mutate(sql) : sql;
}

/**
 * 同じ base の View 群。mutations は { suffix: (sql) => sql } の形で、
 * 特定の 1 本にだけ差を入れる。
 */
function complexRows(mutations) {
  const m = mutations || {};
  return ['abjp', 'abus', 'abuk'].map((s) => ({
    view_name: 'v_order_summary_' + s,
    ddl: complexSql(s, m[s]),
  }));
}

module.exports = { TEMPLATE, COMPLEX_PARTS, COUNTRY, complexSql, complexRows };
