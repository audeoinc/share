// analyze.js の検証。
//   node test.mjs          結果を表示して検証
//   node test.mjs --quiet  PASS/FAIL だけ
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const A = require(join(here, 'analyze.js'));

const quiet = process.argv.includes('--quiet');
const log = (...a) => { if (!quiet) console.log(...a); };

// ---------------------------------------------------------------------
// 実際の状況を模した 10 本。suffix は a…j。
// ロジックは 3 通り。グループ内では参照テーブルの識別子だけでなく、
// 別名やスキーマ名など「suffix 文字列と一致しない差」も入れてある。
// ---------------------------------------------------------------------

// G1: 素の集計。参照テーブルの suffix に加えて、スキーマ名も land が違う
const g1 = (suf, schema) => `CREATE OR REPLACE VIEW \`proj.mart.v_sales_${suf}\` AS
SELECT
  o.order_date,
  o.region,
  COUNT(DISTINCT o.order_id) AS order_count,
  SUM(o.amount) AS gross_amount
FROM \`proj.${schema}.orders_${suf}\` AS o
WHERE o.order_date >= DATE '2025-01-01'
GROUP BY o.order_date, o.region`;

// G2: G1 に customers 結合が加わる（ロジック差）
const g2 = (suf, schema) => `CREATE OR REPLACE VIEW \`proj.mart.v_sales_${suf}\` AS
SELECT
  o.order_date,
  c.region,
  COUNT(DISTINCT o.order_id) AS order_count,
  SUM(o.amount) AS gross_amount
FROM \`proj.${schema}.orders_${suf}\` AS o
LEFT JOIN \`proj.${schema}.customers_${suf}\` AS c
  ON o.customer_id = c.customer_id
WHERE o.order_date >= DATE '2025-01-01'
GROUP BY o.order_date, c.region`;

// G3: G1 に平均が増え、通貨で切る（ロジック差）
const g3 = (suf, schema) => `CREATE OR REPLACE VIEW \`proj.mart.v_sales_${suf}\` AS
SELECT
  o.order_date,
  o.region,
  o.currency,
  COUNT(DISTINCT o.order_id) AS order_count,
  SUM(o.amount) AS gross_amount,
  SUM(o.amount) / NULLIF(COUNT(DISTINCT o.order_id), 0) AS avg_amount
FROM \`proj.${schema}.orders_${suf}\` AS o
WHERE o.order_date >= DATE '2025-01-01'
GROUP BY o.order_date, o.region, o.currency`;

const rows = [
  { view_name: 'v_sales_a', ddl: g1('a', 'raw') },
  { view_name: 'v_sales_b', ddl: g2('b', 'raw') },
  { view_name: 'v_sales_c', ddl: g1('c', 'raw_ex') },   // スキーマ名も違う
  { view_name: 'v_sales_d', ddl: g2('d', 'raw_ex') },
  { view_name: 'v_sales_e', ddl: g1('e', 'raw') },
  { view_name: 'v_sales_f', ddl: g3('f', 'raw') },
  { view_name: 'v_sales_g', ddl: g3('g', 'raw') },
  { view_name: 'v_sales_h', ddl: g3('h', 'raw_ex') },
  { view_name: 'v_sales_i', ddl: g3('i', 'raw') },
  { view_name: 'v_sales_j', ddl: g3('j', 'raw') },
  // 別 base。全部同じロジック（＝正常なケース）
  { view_name: 'v_stock_a', ddl: 'SELECT item_id, qty FROM `proj.raw.stock_a`' },
  { view_name: 'v_stock_b', ddl: 'SELECT item_id, qty FROM `proj.raw.stock_b`' },
];

const res = A.analyze(rows);
const sales = res.bases.find((b) => b.base === 'v_sales');
const stock = res.bases.find((b) => b.base === 'v_stock');

log('=== v_sales ===');
for (const g of sales.groups) {
  log(`\n  グループ [${g.suffixes.join(', ')}]  ${g.members.length} 本`);
  for (const p of g.params) {
    const vals = Object.entries(p.values).map(([s, v]) => `${s}=${v}`).join('  ');
    log(`    ${p.name} (${p.kind}): ${vals}`);
  }
  log('    ── パラメータ化 SQL ──');
  log(g.sql.split('\n').map((l) => '    ' + l).join('\n'));
}

// ---------------------------------------------------------------------
const suffixesOf = (i) => sales.groups[i].suffixes.join(',');
const checks = [
  ['base 名で束ねられる', res.bases.length === 2],
  ['v_sales が 10 本', sales.viewCount === 10],
  ['v_sales が 3 グループ', sales.groupCount === 3],
  ['最大グループが先頭（f,g,h,i,j）', suffixesOf(0) === 'f,g,h,i,j'],
  ['G1 が a,c,e', sales.groups.some((g) => g.suffixes.join(',') === 'a,c,e')],
  ['G2 が b,d', sales.groups.some((g) => g.suffixes.join(',') === 'b,d')],
  ['suffix 以外の差（スキーマ名）も同一ロジックとして束ねる',
    sales.groups.find((g) => g.suffixes.join(',') === 'a,c,e')
      .params.some((p) => Object.values(p.values).some((v) => v.includes('raw_ex')))],
  ['パラメータ化 SQL に {{P1}} が入る', /\{\{P1\}\}/.test(sales.groups[0].sql)],
  ['同じ値の並びは 1 つのパラメータに集約される',
    // orders_x の suffix は複数箇所に出るが値の並びが同じなのでまとまる
    sales.groups[0].params.length <= 3],
  ['グループ間で SQL が異なる（ロジック差が残る）',
    new Set(sales.groups.map((g) => g.sql)).size === 3],
  ['全 suffix 同一ロジックなら 1 グループ', stock.groupCount === 1],
  ['1 グループのときパラメータは差分のみ',
    stock.groups[0].params.length === 1 &&
    stock.groups[0].params[0].values.a === '`proj.raw.stock_a`'],
];

// α 等価が効きすぎないことの確認（予約語・リテラル差はロジック差として残す）
const kw = A.analyze([
  { view_name: 'v_x_a', ddl: 'SELECT a FROM t_a WHERE x = 1' },
  { view_name: 'v_x_b', ddl: 'SELECT a FROM t_b WHERE x = 2' },       // 数値リテラル差
  { view_name: 'v_x_c', ddl: 'SELECT DISTINCT a FROM t_c WHERE x = 1' }, // 予約語差
]).bases[0];
checks.push(['リテラル差は既定でロジック差として残す（同一視しない）', kw.groupCount === 3]);

const kwLoose = A.analyze([
  { view_name: 'v_x_a', ddl: 'SELECT a FROM t_a WHERE x = 1' },
  { view_name: 'v_x_b', ddl: 'SELECT a FROM t_b WHERE x = 2' },
], { substitutable: ['ident', 'quoted', 'number', 'string'] }).bases[0];
checks.push(['substitutable にリテラルを足せば同一視できる', kwLoose.groupCount === 1]);

// suffix 抽出
checks.push(['v_daily_sales は suffix 扱いしない（6 文字超）',
  A.extractSuffix('v_daily_sales') === null ||
  A.extractSuffix('v_daily_sales').suffix.length <= 6]);
checks.push(['suffixList 指定が最優先',
  A.extractSuffix('v_daily_sales', { suffixList: ['jp', 'us'] }) === null]);
checks.push(['suffixList で正しく割れる',
  A.extractSuffix('v_daily_sales_jp', { suffixList: ['jp', 'us'] }).base === 'v_daily_sales']);

// トークナイザ
const tk = A.tokenizeSql("SELECT `a.b_c`, 'x y', 12.5 -- memo\nFROM t");
checks.push(['バッククォート識別子が 1 トークン',
  tk.some((t) => t.kind === 'quoted' && t.text === '`a.b_c`')]);
checks.push(['文字列リテラルが 1 トークン',
  tk.some((t) => t.kind === 'string' && t.text === "'x y'")]);
checks.push(['コメントが 1 トークン', tk.some((t) => t.kind === 'comment')]);
checks.push(['予約語と識別子を区別する',
  tk.some((t) => t.kind === 'keyword' && t.text === 'SELECT') &&
  tk.some((t) => t.kind === 'ident' && t.text === 't')]);

log('\n=== 検証 ===');
let failed = 0;
for (const [name, ok] of checks) {
  if (!ok) failed++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}`);
}
console.log(`\n${checks.length - failed}/${checks.length} passed`);
process.exit(failed === 0 ? 0 : 1);
