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

// OPTIONS 句（BigQuery が返す DDL に description や作成タイムスタンプが入る）
const withOptions = S.sampleRows().map((r, i) => ({
  view_name: r.view_name,
  ddl: r.ddl.replace(/ AS\n/, `\nOPTIONS(\n  description="auto",\n` +
    `  labels=[("created", "2026-08-18T0${i}:11:22Z")]\n)\nAS `),
}));
const wo = A.analyze(withOptions, OPTS).bases[0];
checks.push(['OPTIONS 句は既定で無視する（メタデータでロジックではない）',
  wo.groupCount === 3]);
checks.push(['OPTIONS を無視してもグループ分けは同じ',
  wo.groups.map((g) => g.suffixes.join(',')).join('|') ===
  sales.groups.map((g) => g.suffixes.join(',')).join('|')]);
checks.push(['パラメータ化 SQL に OPTIONS が残らない',
  !/OPTIONS/.test(wo.groups[0].sql)]);
checks.push(['stripOptions:false なら従来どおり割れる',
  A.analyze(withOptions, { ...OPTS, stripOptions: false }).bases[0].groupCount === 9]);
checks.push(['OPTIONS の値に括弧や引用符があっても対応する ) を見つける',
  A.stripOptionsClause(A.tokenizeSql(
    'CREATE VIEW `a` OPTIONS(x="a)b(c", y=[(1,2)]) AS SELECT 1'))
    .map((t) => t.text).join('') === 'CREATE VIEW `a` AS SELECT 1']);

// suffix の伏せ字（suffixAware）
// suffix はデータセット名・テーブル名・リテラルのどこにでも現れる。
// 比較の前にその View 自身の suffix を伏せ字にすると、suffix 由来の差は消え、
// 残った差＝本当のロジック差になる。
const spread = S.allSuffixes().map((e) => ({
  view_name: `v_spread_${e.suffix}`,
  ddl: `SELECT id, '${e.suffix}' AS region\n` +
       `FROM \`p.mart_${e.suffix}.orders_${e.suffix}\`\n` +
       `WHERE src = 'load_${e.suffix}'`,
}));
checks.push(['suffix はデータセット・テーブル・リテラルのどこにあっても吸収する',
  A.analyze(spread, OPTS).bases[0].groupCount === 1]);
checks.push(['suffixAware:false なら suffix 入りリテラルで割れる',
  A.analyze(spread, { ...OPTS, suffixAware: false }).bases[0].groupCount === 9]);

// 伏せ字はロジック差まで消さない
const literalLogic = [
  { view_name: 'v_y_abjp', ddl: "SELECT a FROM t_abjp WHERE status = 'A'" },
  { view_name: 'v_y_abus', ddl: "SELECT a FROM t_abus WHERE status = 'A'" },
  { view_name: 'v_y_cdjp', ddl: "SELECT a FROM t_cdjp WHERE status = 'B'" },
];
const ll = A.analyze(literalLogic, OPTS).bases[0];
checks.push(['suffix 以外のリテラル差はロジック差として残る', ll.groupCount === 2]);
checks.push(['ロジックが同じ 2 本は同じグループに入る',
  ll.groups.some((g) => g.suffixes.join(',') === 'abjp,abus')]);

const masked = A.maskTokens(A.tokenizeSql('SELECT x FROM t_abjp'), 'abjp');
checks.push(['maskTokens はトークン内の suffix だけを置き換える',
  masked.map((t) => t.text).join('').includes('t_') &&
  !masked.map((t) => t.text).join('').includes('abjp')]);
checks.push(['maskTokens は suffix を含まないトークンをそのまま返す',
  masked.filter((t) => t.kind === 'keyword').every((t) => t.text === 'SELECT' || t.text === 'FROM')]);

// SCHEMATA 由来の suffix 一覧（suffixSource: "schemata"）
// 一覧が実行時に決まるだけで、抽出の意味は suffixParts と同じでなければならない。
const listOpts = { suffixList: ['abjp', 'cduk', 'jp'] };
checks.push(['suffixList でも base を切り出せる',
  A.extractSuffix('v_daily_sales_abjp', listOpts).base === 'v_daily_sales']);
checks.push(['suffixList は長い一致を優先する',
  A.extractSuffix('v_x_cduk', listOpts).suffix === 'cduk']);
checks.push(['suffixList にない末尾は対象外',
  A.extractSuffix('v_daily_sales_efus', listOpts) === null]);
checks.push(['suffixList でも suffixParts と同じグループ分けになる',
  A.analyze(rows, { suffixList: A.expandSuffixParts(S.SUFFIX_PARTS) })
    .bases.find((b) => b.base === S.BASE_VIEW)
    .groups.map((g) => g.suffixes.join(',')).join('|') ===
  sales.groups.map((g) => g.suffixes.join(',')).join('|')]);

// リテラルの中の suffix 連動コード
// 'JP' / 'US' のように suffix そのものではないが suffix と連動する値は、
// 語単位・大文字小文字を無視して伏せ字にする。SQL に手を入れずに吸収したい。
const codes = S.allSuffixes().map((e) => ({
  view_name: `v_code_${e.suffix}`,
  ddl: `SELECT id\nFROM \`p.mart_${e.suffix}.orders\`\n` +
       `WHERE country = '${e.suffix.slice(2).toUpperCase()}'\n` +
       `  AND line = '${e.suffix.slice(0, 2)}'`,
}));
checks.push(['リテラルの国コードは suffix と連動していれば吸収する',
  A.analyze(codes, OPTS).bases[0].groupCount === 1]);
checks.push(['literalSuffixWords:false なら従来どおり割れる',
  A.analyze(codes, { ...OPTS, literalSuffixWords: false }).bases[0].groupCount === 9]);

// 連動していないリテラルは残す
const notCodes = [
  { view_name: 'v_z_abjp', ddl: "SELECT a FROM t_abjp WHERE country = 'JP' AND s = 'A'" },
  { view_name: 'v_z_abus', ddl: "SELECT a FROM t_abus WHERE country = 'US' AND s = 'A'" },
  { view_name: 'v_z_cdjp', ddl: "SELECT a FROM t_cdjp WHERE country = 'JP' AND s = 'B'" },
];
const nc = A.analyze(notCodes, OPTS).bases[0];
checks.push(['連動しないリテラル差はロジック差として残る', nc.groupCount === 2]);
checks.push(['連動する値だけ吸収して 2 本がまとまる',
  nc.groups.some((g) => g.suffixes.join(',') === 'abjp,abus')]);

// 語の一部には効かせない（'label' の ab を巻き込まない）
checks.push(['リテラルの語の一部は伏せ字にしない',
  A.maskTokens(A.tokenizeSql("SELECT 'label' AS x"), 'abjp')
    .map((t) => t.text).join('').includes("'label'")]);
checks.push(['語全体が一致すれば伏せ字にする',
  !A.maskTokens(A.tokenizeSql("SELECT 'JP' AS x"), 'abjp')
    .map((t) => t.text).join('').includes("'JP'")]);
checks.push(['語彙は suffix と区分',
  A.suffixWords('abjp').join(',') === 'abjp,ab,jp']);
checks.push(['suffixParts があればそちらを使う',
  A.suffixWords('abjp', ['ab', 'jp']).join(',') === 'abjp,ab,jp']);
checks.push(['奇数長の suffix は分割しない',
  A.suffixWords('abc').join(',') === 'abc']);

// 手で並べる同値リテラル（literalGroups）
// suffix から導けない対応（'apac' ↔ 'amer' など）は人が並べるしかない。
const manual = [
  { view_name: 'v_m_abjp', ddl: "SELECT a FROM t_abjp WHERE zone = 'apac'" },
  { view_name: 'v_m_abus', ddl: "SELECT a FROM t_abus WHERE zone = 'amer'" },
  { view_name: 'v_m_abuk', ddl: "SELECT a FROM t_abuk WHERE zone = 'emea'" },
];
checks.push(['literalGroups なしでは連動が分からないので割れる',
  A.analyze(manual, OPTS).bases[0].groupCount === 3]);
checks.push(['literalGroups に並べれば同一視する',
  A.analyze(manual, { ...OPTS, literalGroups: [['apac', 'amer', 'emea']] })
    .bases[0].groupCount === 1]);
checks.push(['1 段の配列も 1 組として受ける',
  A.analyze(manual, { ...OPTS, literalGroups: ['apac', 'amer', 'emea'] })
    .bases[0].groupCount === 1]);
checks.push(['組が違えば同一視しない',
  A.analyze(manual, { ...OPTS, literalGroups: [['apac'], ['amer'], ['emea']] })
    .bases[0].groupCount === 3]);
checks.push(['大文字小文字は無視する',
  A.analyze([
    { view_name: 'v_m_abjp', ddl: "SELECT a FROM t_abjp WHERE zone = 'APAC'" },
    { view_name: 'v_m_abus', ddl: "SELECT a FROM t_abus WHERE zone = 'amer'" },
  ], { ...OPTS, literalGroups: [['apac', 'amer']] }).bases[0].groupCount === 1]);
checks.push(['並べていない値はロジック差のまま',
  A.analyze([
    { view_name: 'v_m_abjp', ddl: "SELECT a FROM t_abjp WHERE zone = 'apac'" },
    { view_name: 'v_m_abus', ddl: "SELECT a FROM t_abus WHERE zone = 'zzz'" },
  ], { ...OPTS, literalGroups: [['apac', 'amer', 'emea']] }).bases[0].groupCount === 2]);
checks.push(['数値リテラルも並べれば同一視できる',
  A.analyze([
    { view_name: 'v_m_abjp', ddl: 'SELECT a FROM t_abjp WHERE region_id = 1' },
    { view_name: 'v_m_abus', ddl: 'SELECT a FROM t_abus WHERE region_id = 2' },
  ], { ...OPTS, literalGroups: [['1', '2']] }).bases[0].groupCount === 1]);

// 同値リテラルの一覧を 1 本にまとめる（equivalentLiterals）
// "suffix" は「その View 自身の suffix とその区分」を表す予約語。
// これだけは View ごとに中身が変わるので値を並べて書けない。
const eqRows = [
  { view_name: 'v_e_abjp', ddl: "SELECT 'aa' AS id, 'JP' AS c FROM t_abjp" },
  { view_name: 'v_e_abus', ddl: "SELECT 'bb' AS id, 'US' AS c FROM t_abus" },
];
const eqCount = (o) => A.analyze(eqRows, { ...OPTS, ...o }).bases[0].groupCount;
checks.push(['一覧に suffix と組を並べれば両方効く',
  eqCount({ equivalentLiterals: ['suffix', ['aa', 'bb']] }) === 1]);
checks.push(['suffix を書かなければ suffix 語彙は効かない',
  eqCount({ equivalentLiterals: [['aa', 'bb']] }) === 2]);
checks.push(['suffix だけなら連動しない値は残る',
  eqCount({ equivalentLiterals: ['suffix'] }) === 2]);
checks.push(['組が違えば同一視しない（一覧でも）',
  A.analyze([
    { view_name: 'v_e_abjp', ddl: "SELECT 'aa' AS id FROM t_abjp" },
    { view_name: 'v_e_abus', ddl: "SELECT 'cc' AS id FROM t_abus" },
  ], { ...OPTS, equivalentLiterals: ['suffix', ['aa', 'bb'], ['cc', 'dd']] })
    .bases[0].groupCount === 2]);
checks.push(['1 組だけを 1 段で書いても受ける',
  A.analyze([
    { view_name: 'v_e_abjp', ddl: "SELECT 'aa' AS id FROM t_abjp" },
    { view_name: 'v_e_abus', ddl: "SELECT 'bb' AS id FROM t_abus" },
  ], { ...OPTS, equivalentLiterals: ['aa', 'bb'] }).bases[0].groupCount === 1]);
checks.push(['equivalentLiterals が無ければ従来の 2 つの設定で動く',
  A.analyze(manual, { ...OPTS, literalGroups: [['apac', 'amer', 'emea']] })
    .bases[0].groupCount === 1]);
checks.push(['equivalentLiterals を書くと literalGroups は見ない',
  A.analyze(manual, {
    ...OPTS,
    literalGroups: [['apac', 'amer', 'emea']],
    equivalentLiterals: ['suffix'],
  }).bases[0].groupCount === 3]);
checks.push(['parseEquivalents: 予約語と組を仕分ける',
  (() => {
    const r = A.parseEquivalents({ equivalentLiterals: ['suffix', ['aa', 'bb']] });
    return r.useWords === true && r.groups.length === 1 && r.groups[0][1] === 'bb';
  })()]);
checks.push(['語の一部には効かせない',
  A.maskTokens(A.tokenizeSql("SELECT 'apacific' AS x"), null, null,
    { literalGroups: [['apac']] })
    .map((t) => t.text).join('').includes("'apacific'")]);
checks.push(['literalGroups は suffix と独立に効く',
  A.analyze(manual, { ...OPTS, suffixAware: false,
    literalGroups: [['apac', 'amer', 'emea']] }).bases[0].groupCount === 1]);
checks.push(['空の literalGroups は何もしない',
  A.buildLiteralMap([]) === null && A.buildLiteralMap(undefined) === null]);

// リテラルは値の全体が一致したときだけ伏せ字にする
// 語単位で中を探すと 'ORDER_IN_TRANSIT' の IN のような無関係な語まで拾う。
const inWords = A.maskTokens(
  A.tokenizeSql("SELECT a FROM t WHERE s = 'ORDER_IN_TRANSIT'"), 'abin');
checks.push(['区切り文字で割った語には効かない',
  inWords.map((t) => t.text).join('').includes("'ORDER_IN_TRANSIT'")]);
checks.push(['値の全体が一致すれば効く',
  !A.maskTokens(A.tokenizeSql("SELECT 'IN' AS x"), 'abin')
    .map((t) => t.text).join('').includes("'IN'")]);
checks.push(['バッククォート識別子は語照合の対象外',
  A.maskTokens(A.tokenizeSql('SELECT a FROM `p.d.t_jp`'), 'abjp')
    .map((t) => t.text).join('').includes('t_jp')]);
checks.push(['literalGroups も値の全体が一致したときだけ',
  A.maskTokens(A.tokenizeSql("SELECT 'x_apac_y' AS z"), null, null,
    { literalGroups: [['apac']] })
    .map((t) => t.text).join('').includes("'x_apac_y'")]);
checks.push(['identifier の中の suffix は従来どおり伏せ字',
  !A.maskTokens(A.tokenizeSql('SELECT a FROM t_abjp'), 'abjp')
    .map((t) => t.text).join('').includes('abjp')]);
checks.push(['リテラルの中の完全な suffix も従来どおり伏せ字',
  !A.maskTokens(A.tokenizeSql("SELECT 'load_abjp' AS x"), 'abjp')
    .map((t) => t.text).join('').includes('abjp')]);

// グループ判定として: 語の一部の一致で意図せずまとまらない
const inLogic = [
  { view_name: 'v_q_abin', ddl: "SELECT a FROM t_abin WHERE s = 'ORDER_IN_TRANSIT'" },
  { view_name: 'v_q_abus', ddl: "SELECT a FROM t_abus WHERE s = 'ORDER_ON_HOLD'" },
];
checks.push(['語の一部が一致しても別ロジックのままにする',
  A.analyze(inLogic, { suffixList: ['abin', 'abus'] }).bases[0].groupCount === 2]);

// suffix を認識できなかった View
// 出さないとソースが画面から消える。単独の base（1 View / 1 グループ）として並べる。
const withOdd = A.analyze(rows.concat([
  { view_name: 'v_daily_sales', ddl: 'SELECT 1' },
  { view_name: 'v_legacy_report', ddl: 'SELECT 2' },
]), OPTS);
const odd = withOdd.bases.find((b) => b.base === 'v_legacy_report');
checks.push(['未認識の View も base として並ぶ', !!odd]);
checks.push(['未認識は 1 View / 1 グループ',
  odd.viewCount === 1 && odd.groupCount === 1 && odd.unmatched === true]);
checks.push(['未認識でもソースを保持している',
  odd.groups[0].members[0].ddl === 'SELECT 2']);
checks.push(['unmatched は従来どおり件数を持つ', withOdd.unmatched.length === 2]);
checks.push(['suffix 付きのグループ分けは変わらない',
  withOdd.bases.find((b) => b.base === S.BASE_VIEW).groupCount === 3]);
checks.push(['includeUnmatched:false なら従来どおり除外する',
  A.analyze(rows.concat([{ view_name: 'v_legacy_report', ddl: 'SELECT 2' }]),
    { ...OPTS, includeUnmatched: false }).bases.length === 1]);

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
