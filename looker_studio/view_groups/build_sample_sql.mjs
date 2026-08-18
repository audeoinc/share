// BigQuery に検証用サンプル（ソース テーブル + 9 本の View）を作る SQL を生成する。
//   node build_sample_sql.mjs   -> sample_data.sql / sample_teardown.sql
//
// 定義は sample_views.js を参照する（test.mjs と同じ定義なので食い違わない）。
import { writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const S = require(join(here, 'sample_views.js'));

const P = S.PROJECT;
const suffixes = S.allSuffixes();
const datasets = [S.MART, ...new Set(suffixes.map((e) => S.srcDataset(e.country)))];

// --- ソース テーブル ---------------------------------------------------
// View が実際にクエリできるよう、数行ずつ入れておく。
function ordersTable(e) {
  const ds = S.srcDataset(e.country);
  const cur = { jp: 'JPY', us: 'USD', uk: 'GBP' }[e.country];
  return `CREATE OR REPLACE TABLE \`${P}.${ds}.orders_${e.suffix}\` AS
SELECT * FROM UNNEST([
  STRUCT(1 AS order_id, 101 AS customer_id, DATE '2025-03-01' AS order_date,
         1000.0 AS amount, '${cur}' AS currency, 'north' AS region, 'CONFIRMED' AS status),
  STRUCT(2, 102, DATE '2025-03-02', 2500.0, '${cur}', 'south', 'CONFIRMED'),
  STRUCT(3, 101, DATE '2025-03-02', 1750.0, '${cur}', 'north', 'PENDING')
]);`;
}

function customersTable(e) {
  const ds = S.srcDataset(e.country);
  return `CREATE OR REPLACE TABLE \`${P}.${ds}.customers_${e.suffix}\` AS
SELECT * FROM UNNEST([
  STRUCT(101 AS customer_id, 'north' AS region),
  STRUCT(102, 'south')
]);`;
}

// --- 組み立て ---------------------------------------------------------
const lines = [];
const say = (s = '') => lines.push(s);

say('-- =====================================================================');
say('-- View グループ比較の検証用サンプル');
say('--');
say(`-- suffix = {${S.LOGIC_PARTS.join(', ')}} x {${S.COUNTRY_PARTS.join(', ')}} の 4 文字（${suffixes.length} 通り）`);
say('--   前 2 桁 … SQL ロジックの系統。これがグループを決める');
say('--   後 2 桁 … 国。参照先のデータセットとテーブル名が変わる');
say('--');
say('-- 期待するグループ分け:');
for (const logic of S.LOGIC_PARTS) {
  const m = suffixes.filter((e) => e.logic === logic).map((e) => e.suffix);
  say(`--   ${logic}: ${m.join(', ')}`);
}
say('--');
say('-- 国ごとにソース データセットが変わる（suffix 文字列と一致しない差）:');
for (const c of S.COUNTRY_PARTS) say(`--   ${c} -> ${S.srcDataset(c)}`);
say('--');
say('-- PROJECT は自分のプロジェクト ID に置換すること。');
say('-- 片付けは sample_teardown.sql。');
say('-- =====================================================================');
say();
say('-- ---------------------------------------------------------------------');
say('-- 1. データセット');
say('-- ---------------------------------------------------------------------');
for (const ds of datasets) {
  say(`CREATE SCHEMA IF NOT EXISTS \`${P}.${ds}\` OPTIONS (location = 'asia-northeast1');`);
}
say();
say('-- ---------------------------------------------------------------------');
say('-- 2. ソース テーブル');
say('-- ---------------------------------------------------------------------');
for (const e of suffixes) {
  say(ordersTable(e));
  say();
}
// customers は cd 系のロジックだけが参照するが、揃えて全 suffix 分作っておく
for (const e of suffixes) {
  say(customersTable(e));
  say();
}
say('-- ---------------------------------------------------------------------');
say('-- 3. View（9 本 / ロジックは 3 系統）');
say('-- ---------------------------------------------------------------------');
for (const logic of S.LOGIC_PARTS) {
  say(`-- ---- ${logic} 系 ----`);
  for (const e of suffixes.filter((x) => x.logic === logic)) {
    const v = S.viewDef(e);
    say(`CREATE OR REPLACE VIEW ${v.fullName} AS`);
    say(v.query + ';');
    say();
  }
}
say('-- ---------------------------------------------------------------------');
say('-- 4. 確認: INFORMATION_SCHEMA から (view_name, ddl) を取る');
say('--    アナライザにはこの結果を渡す');
say('-- ---------------------------------------------------------------------');
say('-- SELECT table_name AS view_name, ddl');
say(`-- FROM \`${P}.${S.MART}.INFORMATION_SCHEMA.TABLES\``);
say("-- WHERE table_type = 'VIEW'");
say('-- ORDER BY table_name;');

await writeFile(join(here, 'sample_data.sql'), lines.join('\n') + '\n');

// --- 片付け -----------------------------------------------------------
const td = [
  '-- 検証用サンプルの片付け。PROJECT は置換すること。',
  '-- データセットごと消すので、他の用途と同居させていないか確認してから実行する。',
  '',
  ...datasets.map((ds) => `DROP SCHEMA IF EXISTS \`${P}.${ds}\` CASCADE;`),
];
await writeFile(join(here, 'sample_teardown.sql'), td.join('\n') + '\n');

console.log(`suffix ${suffixes.length} 通り / データセット ${datasets.length} / View ${suffixes.length} 本`);
console.log('wrote sample_data.sql, sample_teardown.sql');
