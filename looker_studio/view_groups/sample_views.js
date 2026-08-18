'use strict';
/**
 * 検証用サンプルの定義。
 * BigQuery にサンプルを作る SQL（build_sample_sql.mjs）と、
 * アナライザのテスト（test.mjs）の両方がここを参照する。
 * 片方だけ直して食い違うことがないよう、定義は 1 箇所に置く。
 *
 * suffix は {ab, cd, ef} × {jp, us, uk} の 4 文字（9 通り）。
 *   前 2 桁 … SQL ロジックの系統。これがグループを決める
 *   後 2 桁 … 国。参照先のデータセットとテーブル名が変わる
 *
 * 「グループ内では参照テーブルの識別子だけが異なる」を再現しつつ、
 * データセット名も国ごとに変えて「suffix 文字列と一致しない差」も混ぜてある。
 */

const LOGIC_PARTS = ['ab', 'cd', 'ef'];
const COUNTRY_PARTS = ['jp', 'us', 'uk'];
const SUFFIX_PARTS = [LOGIC_PARTS, COUNTRY_PARTS];

/** 国 → ソース データセットの接尾辞。suffix と一致しないので単純置換では揃わない。 */
const REGION_OF = { jp: 'apac', us: 'amer', uk: 'emea' };

const PROJECT = 'PROJECT';
const MART = 'sample_mart';
const srcDataset = (country) => `sample_src_${REGION_OF[country]}`;

/** 全 suffix（abjp, abus, … efuk）を並び順つきで返す。 */
function allSuffixes() {
  const out = [];
  for (const logic of LOGIC_PARTS) {
    for (const country of COUNTRY_PARTS) {
      out.push({ suffix: logic + country, logic, country });
    }
  }
  return out;
}

const BASE_VIEW = 'v_daily_sales';

// ---------------------------------------------------------------------
// 3 系統のロジック
//   ab: 素の集計
//   cd: customers を結合して region を取り直す
//   ef: 通貨で切って平均を足す
// ---------------------------------------------------------------------
const LOGIC = {
  ab: ({ orders }) => `SELECT
  o.order_date,
  o.region,
  COUNT(DISTINCT o.order_id) AS order_count,
  SUM(o.amount) AS gross_amount
FROM ${orders} AS o
WHERE o.order_date >= DATE '2025-01-01'
GROUP BY o.order_date, o.region`,

  cd: ({ orders, customers }) => `SELECT
  o.order_date,
  c.region,
  COUNT(DISTINCT o.order_id) AS order_count,
  SUM(o.amount) AS gross_amount
FROM ${orders} AS o
LEFT JOIN ${customers} AS c
  ON o.customer_id = c.customer_id
WHERE o.order_date >= DATE '2025-01-01'
GROUP BY o.order_date, c.region`,

  ef: ({ orders }) => `SELECT
  o.order_date,
  o.region,
  o.currency,
  COUNT(DISTINCT o.order_id) AS order_count,
  SUM(o.amount) AS gross_amount,
  SUM(o.amount) / NULLIF(COUNT(DISTINCT o.order_id), 0) AS avg_amount
FROM ${orders} AS o
WHERE o.order_date >= DATE '2025-01-01'
GROUP BY o.order_date, o.region, o.currency`,
};

/** 1 本分の View 定義を組み立てる。 */
function viewDef(entry, project) {
  const p = project || PROJECT;
  const ds = srcDataset(entry.country);
  const refs = {
    orders: `\`${p}.${ds}.orders_${entry.suffix}\``,
    customers: `\`${p}.${ds}.customers_${entry.suffix}\``,
  };
  return {
    ...entry,
    viewName: `${BASE_VIEW}_${entry.suffix}`,
    fullName: `\`${p}.${MART}.${BASE_VIEW}_${entry.suffix}\``,
    srcDataset: ds,
    query: LOGIC[entry.logic](refs),
  };
}

/** INFORMATION_SCHEMA から取れるのと同じ形（view_name, ddl）でサンプルを返す。 */
function sampleRows(project) {
  return allSuffixes().map((e) => {
    const v = viewDef(e, project);
    return {
      view_name: v.viewName,
      ddl: `CREATE VIEW ${v.fullName} AS\n${v.query};`,
    };
  });
}

module.exports = {
  LOGIC_PARTS, COUNTRY_PARTS, SUFFIX_PARTS, REGION_OF,
  PROJECT, MART, BASE_VIEW, srcDataset,
  allSuffixes, viewDef, sampleRows, LOGIC,
};
