// analyze.js の検証。
//   node test.mjs          結果を表示して検証
//   node test.mjs --quiet  PASS/FAIL だけ
//
// サンプルの定義は sample_views.js（BigQuery に流す sample_data.sql と同じもの）を使う。
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const A = require(join(here, 'analyze.js'));
const S = require(join(here, 'sample_views.js'));

const quiet = process.argv.includes('--quiet');
const log = (...a) => { if (!quiet) console.log(...a); };

// suffix = {ab,cd,ef} x {jp,us,uk} の 4 文字
const OPTS = { suffixParts: S.SUFFIX_PARTS };

const rows = S.sampleRows();
const res = A.analyze(rows, OPTS);
const sales = res.bases.find((b) => b.base === S.BASE_VIEW);

log(`=== ${S.BASE_VIEW}（${sales.viewCount} 本 → ${sales.groupCount} グループ）===`);
for (const g of sales.groups) {
  log(`\n  [${g.suffixes.join(', ')}]  ${g.members.length} 本`);
  for (const p of g.params) {
    log(`    ${p.name} (${p.kind})`);
    for (const [s, v] of Object.entries(p.values)) log(`      ${s} = ${v}`);
  }
  log('    ── パラメータ化 SQL ──');
  log(g.sql.split('\n').map((l) => '      ' + l).join('\n'));
}

const groupOf = (suf) => sales.groups.find((g) => g.suffixes.includes(suf));

const checks = [
  ['9 本すべて suffix を認識', sales.viewCount === 9 && res.unmatched.length === 0],
  ['base 名は suffix を除いた形', sales.base === 'v_daily_sales'],
  ['3 グループに分かれる', sales.groupCount === 3],
  ['ab 系がまとまる', groupOf('abjp').suffixes.join(',') === 'abjp,abuk,abus'],
  ['cd 系がまとまる', groupOf('cdjp').suffixes.join(',') === 'cdjp,cduk,cdus'],
  ['ef 系がまとまる', groupOf('efjp').suffixes.join(',') === 'efjp,efuk,efus'],
  ['系統をまたいで混ざらない',
    new Set(sales.groups.map((g) => g.suffixes[0].slice(0, 2))).size === 3],
  ['データセット名の差（apac/amer/emea）も同一ロジックとして吸収する',
    groupOf('abjp').params.some((p) => {
      const v = Object.values(p.values).join(' ');
      return v.includes('apac') && v.includes('amer') && v.includes('emea');
    })],
  ['グループ間のパラメータ化 SQL は異なる（ロジック差が残る）',
    new Set(sales.groups.map((g) => g.sql)).size === 3],
  ['パラメータ化 SQL の改行が保たれている', groupOf('abjp').sql.split('\n').length > 5],
  ['cd 系は customers も別パラメータになる', groupOf('cdjp').params.length >= 3],
  ['ab 系のパラメータは View 名と orders の 2 つ', groupOf('abjp').params.length === 2],
  ['パラメータ値に suffix が現れる',
    JSON.stringify(groupOf('efjp').params).includes('efuk')],
];

// suffix 抽出
checks.push(['4 文字 suffix を正しく割る',
  A.extractSuffix('v_daily_sales_abjp', { ...OPTS }).base === 'v_daily_sales']);
checks.push(['区分の内訳を返す',
  JSON.stringify(A.extractSuffix('v_daily_sales_efuk', { ...OPTS }).parts) === '["ef","uk"]']);
checks.push(['suffix なしは対象外', A.extractSuffix('v_daily_sales', { ...OPTS }) === null]);
checks.push(['未知の組み合わせは対象外',
  A.extractSuffix('v_daily_sales_abzz', { ...OPTS }) === null]);
checks.push(['9 通りに展開される',
  A.expandSuffixParts(S.SUFFIX_PARTS).join(',') ===
  'abjp,abuk,abus,cdjp,cduk,cdus,efjp,efuk,efus']);

// α 等価が効きすぎないことの確認
const strict = A.analyze([
  { view_name: 'v_x_abjp', ddl: 'SELECT a FROM t_abjp WHERE x = 1' },
  { view_name: 'v_x_abus', ddl: 'SELECT a FROM t_abus WHERE x = 2' },        // 数値リテラル差
  { view_name: 'v_x_abuk', ddl: 'SELECT DISTINCT a FROM t_abuk WHERE x = 1' }, // 予約語差
], OPTS).bases[0];
checks.push(['リテラル差は既定でロジック差として残す', strict.groupCount === 3]);

const loose = A.analyze([
  { view_name: 'v_x_abjp', ddl: 'SELECT a FROM t_abjp WHERE x = 1' },
  { view_name: 'v_x_abus', ddl: 'SELECT a FROM t_abus WHERE x = 2' },
], { ...OPTS, substitutable: ['ident', 'quoted', 'number', 'string'] }).bases[0];
checks.push(['substitutable にリテラルを足せば同一視できる', loose.groupCount === 1]);

// 全 suffix 同一ロジック（＝正常）のケース
const uniform = A.analyze(
  S.allSuffixes().map((e) => ({
    view_name: `v_stock_${e.suffix}`,
    ddl: `SELECT item_id, qty FROM \`p.${S.srcDataset(e.country)}.stock_${e.suffix}\``,
  })), OPTS).bases[0];
checks.push(['全 suffix 同一ロジックなら 1 グループ', uniform.groupCount === 1]);

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
