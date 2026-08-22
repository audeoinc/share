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
  ['cd 系は orders と customers の 2 パラメータ', groupOf('cdjp').params.length === 2],
  ['ab 系のパラメータは orders の 1 つ', groupOf('abjp').params.length === 1],
  ['パラメータの種別は実体名', groupOf('abjp').params.every((p) => p.kind === 'entity')],
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
// 既定ではリテラルは値としてパラメータ化されるので、abjp と abus はまとまる。
// 予約語の差（DISTINCT）は構造の差なので残る。
checks.push(['リテラル差は既定でパラメータ化して同じグループにする',
  strict.groupCount === 2]);
checks.push(['予約語の差は既定でもロジック差として残る',
  strict.groups.some((g) => g.suffixes.join(',') === 'abjp,abus') &&
  strict.groups.some((g) => g.suffixes.join(',') === 'abuk')]);
checks.push(['substitutable を絞ればリテラル差も残せる',
  A.analyze([
    { view_name: 'v_x_abjp', ddl: 'SELECT a FROM t_abjp WHERE x = 1' },
    { view_name: 'v_x_abus', ddl: 'SELECT a FROM t_abus WHERE x = 2' },
  ], { ...OPTS, substitutable: ['entity'] }).bases[0].groupCount === 2]);

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
// ヘッダの View 名は全 View で同じにする。View 自身の名前は FROM / JOIN の
// 実体名ではないので、名前を変えるとそれだけで全部が別グループに割れてしまい、
// OPTIONS を落とせているかどうかが見えなくなる。
const withOptions = S.sampleRows().map((r, i) => ({
  view_name: r.view_name,
  ddl: 'CREATE VIEW `p.d.v`\nOPTIONS(\n  description="auto",\n' +
    `  labels=[("created", "2026-08-18T0${i}:11:22Z")]\n)\nAS\n` + r.ddl,
}));
const wo = A.analyze(withOptions, OPTS).bases[0];
checks.push(['OPTIONS 句は既定で無視する（メタデータでロジックではない）',
  wo.groupCount === 3]);
checks.push(['OPTIONS を無視してもグループ分けは同じ',
  wo.groups.map((g) => g.suffixes.join(',')).join('|') ===
  sales.groups.map((g) => g.suffixes.join(',')).join('|')]);
checks.push(['パラメータ化 SQL に OPTIONS が残らない',
  !/OPTIONS/.test(wo.groups[0].sql)]);
// 既定ではタイムスタンプも値としてパラメータ化されるので、
// OPTIONS を残しても割れない。落とす価値が見えるのは substitutable を
// 絞った運用のほうなので、そちらで確かめる。
checks.push(['stripOptions:false なら OPTIONS の差で割れる',
  A.analyze(withOptions, { ...OPTS, substitutable: ['entity'], stripOptions: false })
    .bases[0].groupCount === 9]);
checks.push(['既定では OPTIONS を残しても値として吸収される',
  A.analyze(withOptions, { ...OPTS, stripOptions: false })
    .bases[0].groupCount === 3]);
checks.push(['OPTIONS の値に括弧や引用符があっても対応する ) を見つける',
  A.stripOptionsClause(A.tokenizeSql(
    'CREATE VIEW `a` OPTIONS(x="a)b(c", y=[(1,2)]) AS SELECT 1'))
    .map((t) => t.text).join('') === 'CREATE VIEW `a` AS SELECT 1']);

// --- ここから下は substitutable を絞って検証する -----------------------
// 既定ではリテラルが置換対象なので、伏せ字や同値リテラルの有無で差が出ない。
// これらは「リテラル差をロジック差として残したい」運用のための仕組みなので、
// その設定（実体名だけを置換対象にする）で検証する。
const STRICT = { ...OPTS, substitutable: ['entity'] };

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
  A.analyze(spread, STRICT).bases[0].groupCount === 1]);
checks.push(['suffixAware:false なら suffix 入りリテラルで割れる',
  A.analyze(spread, { ...STRICT, suffixAware: false }).bases[0].groupCount === 9]);

// 伏せ字はロジック差まで消さない
const literalLogic = [
  { view_name: 'v_y_abjp', ddl: "SELECT a FROM t_abjp WHERE status = 'A'" },
  { view_name: 'v_y_abus', ddl: "SELECT a FROM t_abus WHERE status = 'A'" },
  { view_name: 'v_y_cdjp', ddl: "SELECT a FROM t_cdjp WHERE status = 'B'" },
];
const ll = A.analyze(literalLogic, STRICT).bases[0];
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
  A.analyze(codes, STRICT).bases[0].groupCount === 1]);
checks.push(['literalSuffixWords:false なら従来どおり割れる',
  A.analyze(codes, { ...STRICT, literalSuffixWords: false }).bases[0].groupCount === 9]);

// 連動していないリテラルは残す
const notCodes = [
  { view_name: 'v_z_abjp', ddl: "SELECT a FROM t_abjp WHERE country = 'JP' AND s = 'A'" },
  { view_name: 'v_z_abus', ddl: "SELECT a FROM t_abus WHERE country = 'US' AND s = 'A'" },
  { view_name: 'v_z_cdjp', ddl: "SELECT a FROM t_cdjp WHERE country = 'JP' AND s = 'B'" },
];
const nc = A.analyze(notCodes, STRICT).bases[0];
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
  A.analyze(manual, STRICT).bases[0].groupCount === 3]);
checks.push(['literalGroups に並べれば同一視する',
  A.analyze(manual, { ...STRICT, literalGroups: [['apac', 'amer', 'emea']] })
    .bases[0].groupCount === 1]);
checks.push(['1 段の配列も 1 組として受ける',
  A.analyze(manual, { ...STRICT, literalGroups: ['apac', 'amer', 'emea'] })
    .bases[0].groupCount === 1]);
checks.push(['組が違えば同一視しない',
  A.analyze(manual, { ...STRICT, literalGroups: [['apac'], ['amer'], ['emea']] })
    .bases[0].groupCount === 3]);
checks.push(['大文字小文字は無視する',
  A.analyze([
    { view_name: 'v_m_abjp', ddl: "SELECT a FROM t_abjp WHERE zone = 'APAC'" },
    { view_name: 'v_m_abus', ddl: "SELECT a FROM t_abus WHERE zone = 'amer'" },
  ], { ...STRICT, literalGroups: [['apac', 'amer']] }).bases[0].groupCount === 1]);
checks.push(['並べていない値はロジック差のまま',
  A.analyze([
    { view_name: 'v_m_abjp', ddl: "SELECT a FROM t_abjp WHERE zone = 'apac'" },
    { view_name: 'v_m_abus', ddl: "SELECT a FROM t_abus WHERE zone = 'zzz'" },
  ], { ...STRICT, literalGroups: [['apac', 'amer', 'emea']] }).bases[0].groupCount === 2]);
checks.push(['数値リテラルも並べれば同一視できる',
  A.analyze([
    { view_name: 'v_m_abjp', ddl: 'SELECT a FROM t_abjp WHERE region_id = 1' },
    { view_name: 'v_m_abus', ddl: 'SELECT a FROM t_abus WHERE region_id = 2' },
  ], { ...STRICT, literalGroups: [['1', '2']] }).bases[0].groupCount === 1]);

// 同値リテラルの一覧を 1 本にまとめる（equivalentLiterals）
// "suffix" は「その View 自身の suffix とその区分」を表す予約語。
// これだけは View ごとに中身が変わるので値を並べて書けない。
const eqRows = [
  { view_name: 'v_e_abjp', ddl: "SELECT 'aa' AS id, 'JP' AS c FROM t_abjp" },
  { view_name: 'v_e_abus', ddl: "SELECT 'bb' AS id, 'US' AS c FROM t_abus" },
];
const eqCount = (o) => A.analyze(eqRows, { ...STRICT, ...o }).bases[0].groupCount;
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
  ], { ...STRICT, equivalentLiterals: ['suffix', ['aa', 'bb'], ['cc', 'dd']] })
    .bases[0].groupCount === 2]);
checks.push(['1 組だけを 1 段で書いても受ける',
  A.analyze([
    { view_name: 'v_e_abjp', ddl: "SELECT 'aa' AS id FROM t_abjp" },
    { view_name: 'v_e_abus', ddl: "SELECT 'bb' AS id FROM t_abus" },
  ], { ...STRICT, equivalentLiterals: ['aa', 'bb'] }).bases[0].groupCount === 1]);
checks.push(['equivalentLiterals が無ければ従来の 2 つの設定で動く',
  A.analyze(manual, { ...STRICT, literalGroups: [['apac', 'amer', 'emea']] })
    .bases[0].groupCount === 1]);
checks.push(['equivalentLiterals を書くと literalGroups は見ない',
  A.analyze(manual, {
    ...STRICT,
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
  A.analyze(inLogic, { suffixList: ['abin', 'abus'], substitutable: ['entity'] })
    .bases[0].groupCount === 2]);

// --- 置換してよいのは実体名と値だけ -----------------------------------
// 横展開はロジックが同じならコピーで行う運用なので、SQL の中で閉じた名前
// （列名・別名・CTE 名・ウィンドウ名）が違えば、それは環境差ではなく
// 書き換えの差。意味が同じでも書き方が違えば別グループにする。
{
  const P = { suffixParts: [['ab'], ['jp', 'us']] };
  const two = (a, b) => A.analyze(
    [{ view_name: 'v_e_abjp', ddl: a }, { view_name: 'v_e_abus', ddl: b }], P
  ).bases[0].groupCount;

  checks.push(['FROM の実体名はパラメータ化する（バッククォート）',
    two('SELECT a FROM `p.d.t_abjp`', 'SELECT a FROM `p.d.t_abus`') === 1]);
  checks.push(['FROM の実体名はパラメータ化する（裸）',
    two('SELECT a FROM p.d.t_abjp', 'SELECT a FROM p.d.t_abus') === 1]);
  checks.push(['JOIN の実体名もパラメータ化する',
    two('SELECT a FROM t_abjp JOIN u_abjp ON a=b',
        'SELECT a FROM t_abus JOIN w_abus ON a=b') === 1]);
  checks.push(['FROM a, b のように並んでもパラメータ化する',
    two('SELECT a FROM t_abjp, u_abjp', 'SELECT a FROM t_abus, u_abus') === 1]);
  checks.push(['バッククォート内の部分数が違ってもパラメータ化する',
    two('SELECT a FROM `p.d.t_abjp`', 'SELECT a FROM `d.t_abus`') === 1]);

  checks.push(['バッククォートの有無が違えば別グループ',
    two('SELECT a FROM `p.d.t_abjp`', 'SELECT a FROM p.d.t_abus') === 2]);
  checks.push(['裸で部分数が違えば別グループ',
    two('SELECT a FROM p.d.t_abjp', 'SELECT a FROM d.t_abus') === 2]);

  checks.push(['列名が違えば別グループ',
    two('SELECT amount FROM t_abjp', 'SELECT revenue FROM t_abus') === 2]);
  checks.push(['テーブル別名が違えば別グループ',
    two('SELECT o.a FROM t_abjp AS o', 'SELECT ord.a FROM t_abus AS ord') === 2]);
  checks.push(['列別名が違えば別グループ',
    two('SELECT a AS amount FROM t_abjp', 'SELECT a AS total FROM t_abus') === 2]);
  checks.push(['CTE 名が違えば別グループ',
    two('WITH daily AS (SELECT a FROM t_abjp) SELECT * FROM daily',
        'WITH dly AS (SELECT a FROM t_abus) SELECT * FROM dly') === 2]);
  checks.push(['CTE 名が同じならまとまる',
    two('WITH daily AS (SELECT a FROM t_abjp) SELECT * FROM daily',
        'WITH daily AS (SELECT a FROM t_abus) SELECT * FROM daily') === 1]);
  checks.push(['ウィンドウ名が違えば別グループ',
    two('SELECT SUM(a) OVER w FROM t_abjp WINDOW w AS (PARTITION BY b)',
        'SELECT SUM(a) OVER win FROM t_abus WINDOW win AS (PARTITION BY b)') === 2]);
  checks.push(['関数名が違えば別グループ',
    two('SELECT my_udf(a) FROM t_abjp', 'SELECT other_udf(a) FROM t_abus') === 2]);
}

// markEntities: 実体名だけに印を付ける
{
  const ent = (sql) => A.markEntities(A.tokenizeSql(sql))
    .filter((t) => t.kind === 'entity').map((t) => t.text).join(',');
  checks.push(['バッククォートの実体名を 1 トークンで拾う',
    ent('SELECT a FROM `p.d.t`') === '`p.d.t`']);
  checks.push(['裸の実体名はドット区切りで全部拾う',
    ent('SELECT a FROM p.d.t') === 'p,d,t']);
  checks.push(['別名は実体名にしない',
    ent('SELECT a FROM d.t AS o') === 'd,t']);
  checks.push(['EXTRACT(… FROM …) の FROM は実体名にしない',
    ent('SELECT EXTRACT(HOUR FROM ts) FROM d.t') === 'd,t']);
  checks.push(['UNNEST など関数呼び出しは実体名にしない',
    ent('SELECT a FROM UNNEST(arr) AS x') === '']);
  checks.push(['サブクエリは実体名にしない',
    ent('SELECT a FROM (SELECT 1) AS x') === '']);
  checks.push(['列参照は実体名にしない',
    ent('SELECT o.amount FROM d.t AS o WHERE o.k = 1') === 'd,t']);

  // 実際の View に出てくる書き方で、拾いすぎ・取りこぼしが無いか
  checks.push(['ワイルドカード テーブルを拾う',
    ent('SELECT 1 FROM `p.d.events_*`') === '`p.d.events_*`']);
  checks.push(['FOR SYSTEM_TIME AS OF が続いても拾う',
    ent('SELECT 1 FROM `p.d.t` FOR SYSTEM_TIME AS OF ts') === '`p.d.t`']);
  checks.push(['PIVOT / UNPIVOT が続いても拾う',
    ent('SELECT * FROM `p.d.t` PIVOT(SUM(v) FOR k IN ("a"))') === '`p.d.t`' &&
    ent('SELECT * FROM `p.d.t` UNPIVOT(v FOR k IN (a, b))') === '`p.d.t`']);
  checks.push(['JOIN UNNEST は実体名にしない',
    ent('SELECT 1 FROM `p.d.t` AS t JOIN UNNEST(t.a) AS x ON TRUE') === '`p.d.t`']);
  checks.push(['テーブル関数（ML.PREDICT など）は実体名にしない',
    ent('SELECT * FROM ML.PREDICT(MODEL `p.d.m`, TABLE `p.d.t`)') === '']);
  checks.push(['UNION の両側から拾う',
    ent('SELECT 1 FROM d.a UNION ALL SELECT 1 FROM d.b') === 'd,a,d,b']);
  checks.push(['IN (SELECT … FROM …) の中も拾う',
    ent('SELECT 1 FROM d.a WHERE k IN (SELECT k FROM d.b)') === 'd,a,d,b']);
  checks.push(['入れ子の WITH の中も拾う',
    ent('SELECT 1 FROM (WITH z AS (SELECT 1 FROM d.inner_t) SELECT * FROM z) AS s')
      === 'd,inner_t,z']);
  checks.push(['コメントの中の FROM に釣られない',
    ent('SELECT 1 -- FROM fake_t\nFROM d.real_t') === 'd,real_t']);
  checks.push(['文字列の中の FROM に釣られない',
    ent("SELECT 'FROM fake_t' AS s FROM d.real_t") === 'd,real_t']);

  // テーブル関数を実体名にすると、関数が差し替わっても同じロジックに見えてしまう
  checks.push(['テーブル関数が違えば別グループ',
    A.analyze([
      { view_name: 'v_f_abjp', ddl: 'SELECT * FROM ML.PREDICT(MODEL `p.d.m`, TABLE `p.d.t`)' },
      { view_name: 'v_f_abus', ddl: 'SELECT * FROM ML.FORECAST(MODEL `p.d.m`, TABLE `p.d.t`)' },
    ], { suffixParts: [['ab'], ['jp', 'us']] }).bases[0].groupCount === 2]);
}

// --- リテラルの書き方（lineage の lexer に合わせる）------------------------
// 1 つのリテラルを複数トークンに割ってしまうと、値の差なのに
// 「トークン数が違う」で別グループになる。lineage/javascript/src/lexer/lexer.js
// が扱っている形を突き合わせて、取りこぼしが無いかを見る。
{
  const one = (sql) => {
    const t = A.tokenizeSql(sql).filter((x) => x.kind !== 'space');
    return t.length === 1 ? t[0].kind : t.map((x) => x.kind).join('+');
  };
  const D = String.fromCharCode(34);  // 二重引用符。ソースに 3 連を書かない
  const D3 = D + D + D;
  checks.push(['単一引用符 3 連を 1 トークンにする', one("'''a b'''") === 'string']);
  checks.push(['二重引用符 3 連を 1 トークンにする', one(D3 + 'a b' + D3) === 'string']);
  checks.push(['raw 文字列 r-quote を 1 トークンにする', one("r'^\\d+$'") === 'string']);
  checks.push(['bytes 文字列 b-quote を 1 トークンにする', one("b'abc'") === 'string']);
  checks.push(['rb / br の組み合わせも 1 トークンにする',
    one("rb'x'") === 'string' && one("br'x'") === 'string']);
  checks.push(['引用符の二重化を 1 トークンにする', one("'it''s'") === 'string']);
  checks.push(['バックスラッシュのエスケープも 1 トークンにする', one("'a\\'b'") === 'string']);
  checks.push(['指数表記を 1 トークンにする',
    one('1e6') === 'number' && one('2E-4') === 'number' && one('1.5e3') === 'number']);
  checks.push(['16 進を 1 トークンにする', one('0x1F') === 'number']);
  checks.push(['先頭ドットの小数を 1 トークンにする', one('.5') === 'number']);
  checks.push(['小数はそのまま 1 トークン', one('1.5') === 'number']);
  // 'p.d.t_123' の '.' を数値に食わせない（lineage も同じ理由で場合分けしている）。
  // 食わせるとパスが壊れ、実体名の検出が狂う。
  checks.push(['パスのドットを数値に食わせない',
    A.tokenizeSql('p.d.t_123').filter((x) => x.kind !== 'space')
      .map((x) => x.text).join('|') === 'p|.|d|.|t_123']);

  // 取りこぼしていれば、値だけの差でも別グループになる
  const P = { suffixParts: [['ab'], ['jp', 'us']] };
  const same = (label, a, b) => {
    const r = A.analyze([
      { view_name: 'v_l_abjp', ddl: 'SELECT a FROM t_abjp WHERE ' + a },
      { view_name: 'v_l_abus', ddl: 'SELECT a FROM t_abus WHERE ' + b },
    ], P).bases[0];
    checks.push([label, r.groupCount === 1]);
  };
  same('指数表記の値の差はパラメータ化', 'n > 1e6', 'n > 2e7');
  same('16 進の値の差はパラメータ化', 'n = 0x1F', 'n = 0x2A');
  same('引用符を二重化した値の差はパラメータ化', "s = 'it''s'", "s = 'ok'");
  same('raw 文字列の値の差はパラメータ化',
    "REGEXP_CONTAINS(s, r'^A\\d+$')", "REGEXP_CONTAINS(s, r'^B\\d+$')");
  same('3 連引用符の値の差はパラメータ化', "s = '''alpha'''", "s = '''beta'''");
}

// --- WHERE / CASE / IF のリテラル条件 -----------------------------------
// 横展開で実際にいちばん多いのがここ。国ごとにしきい値・区分値・対象コードが
// 変わる。値の差はパラメータ化して同じグループにし、条件の構造が変われば割る。
{
  const P = { suffixParts: [['ab'], ['jp', 'us']] };
  const pair = (a, b) => A.analyze(
    [{ view_name: 'v_w_abjp', ddl: a }, { view_name: 'v_w_abus', ddl: b }], P
  ).bases[0];
  const where = (a, b) => pair(
    'SELECT a FROM t_abjp WHERE ' + a, 'SELECT a FROM t_abus WHERE ' + b);
  const expr = (a, b) => pair(
    'SELECT ' + a + ' AS x FROM t_abjp', 'SELECT ' + b + ' AS x FROM t_abus');
  const same = (label, b, valueShown) => {
    const shown = JSON.stringify(b.groups[0].params.filter((p) => p.kind !== 'entity'));
    checks.push([label, b.groupCount === 1 && (!valueShown || shown.includes(valueShown))]);
  };
  const cut = (label, b, reason) => {
    const g = b.groups.find((x) => x.miss);
    checks.push([label, b.groupCount === 2 && (!reason || (g && g.miss.detail.reason === reason))]);
  };

  // 値だけが違う → パラメータ化して同じグループ
  same('WHERE: 文字列の等値はパラメータ化', where("s = 'A'", "s = 'B'"), "'B'");
  same('WHERE: 数値の等値はパラメータ化', where('n = 1', 'n = 2'), '2');
  same('WHERE: 日付リテラルはパラメータ化',
    where("d >= DATE '2025-01-01'", "d >= DATE '2025-04-01'"), '2025-04-01');
  same('WHERE: LIKE のパターンはパラメータ化',
    where("s LIKE 'AB%'", "s LIKE 'CD%'"), "'CD%'");
  same('WHERE: BETWEEN の上下限はパラメータ化',
    where('n BETWEEN 1 AND 10', 'n BETWEEN 5 AND 20'), '20');
  same('WHERE: IN の中身はパラメータ化',
    where("s IN ('A','B')", "s IN ('C','D')"), "'D'");
  same('CASE: THEN の値と閾値はパラメータ化',
    expr("CASE WHEN n >= 100 THEN 'BIG' ELSE 'SMALL' END",
         "CASE WHEN n >= 200 THEN 'LARGE' ELSE 'MINI' END"), "'LARGE'");
  same('CASE: 値指定の CASE もパラメータ化',
    expr("CASE region WHEN 'JP' THEN 1 ELSE 0 END",
         "CASE region WHEN 'US' THEN 1 ELSE 0 END"), "'US'");
  same('IF: 条件の値と戻り値はパラメータ化',
    expr("IF(n >= 100, 'A', 'B')", "IF(n >= 200, 'C', 'D')"), "'C'");

  // 条件の構造が変わる → 別グループ
  cut('WHERE: IN の要素数が違えば割れる',
    where("s IN ('A','B')", "s IN ('A','B','C')"), 'length');
  cut('WHERE: 真偽値の違いは割れる（予約語）',
    where('f = TRUE', 'f = FALSE'), 'not-substitutable');
  cut('WHERE: IS NULL と IS NOT NULL は割れる',
    where('x IS NULL', 'x IS NOT NULL'), 'length');
  cut('WHERE: 比較演算子が違えば割れる',
    where('n >= 100', 'n > 100'), 'length');
  cut('WHERE: 条件の順序が違えば割れる',
    where("a = 'X' AND b = 'Y'", "b = 'Y' AND a = 'X'"), 'not-substitutable');
  cut('CASE: WHEN の数が違えば割れる',
    expr("CASE WHEN n >= 100 THEN 'A' ELSE 'B' END",
         "CASE WHEN n >= 100 THEN 'A' WHEN n >= 50 THEN 'C' ELSE 'B' END"), 'length');
  cut('CASE: ELSE の有無が違えば割れる',
    expr("CASE WHEN n >= 100 THEN 'A' ELSE 'B' END",
         "CASE WHEN n >= 100 THEN 'A' END"), 'length');
  cut('IF: 条件に使う列が違えば割れる',
    expr("IF(n >= 100, 'A', 'B')", "IF(m >= 100, 'A', 'B')"), 'not-substitutable');
  cut('IF と CASE の書き換えは割れる',
    expr("IF(n >= 100, 'A', 'B')", "CASE WHEN n >= 100 THEN 'A' ELSE 'B' END"), 'length');
  cut('COALESCE の引数が増えれば割れる',
    expr('COALESCE(a, b)', 'COALESCE(a, b, c)'), 'length');

  // 対応が 1 対 1 にならない置き換えは割る（値だからと何でも同一視はしない）
  cut('同じ値が別々の値に対応していれば割れる',
    where("a = 'X' AND b = 'X'", "a = 'Y' AND b = 'Z'"), 'inconsistent');
  cut('別々の値が同じ値に対応していれば割れる',
    where("a = 'X' AND b = 'Y'", "a = 'Z' AND b = 'Z'"), 'not-injective');

  // 符号や表記のゆれ。数値リテラルは値なので、符号の有無はトークン数の差になる。
  cut('負号の有無はトークン数の差として割れる',
    expr('IFNULL(n, 0)', 'IFNULL(n, -1)'), 'length');
  same('負号どうしならパラメータ化', expr('IFNULL(n, -1)', 'IFNULL(n, -2)'), '2');
}

// --- 複雑な SQL での検証 ------------------------------------------------
// 単純な SELECT だけだと実体名の検出が素通りしてしまうので、多段 CTE /
// 名前付きウィンドウ / QUALIFY / UNION / UNNEST / 相関サブクエリを入れた
// 1 本で、取りこぼしと拾いすぎの両方を見る。
{
  const C = require(join(here, 'sample_complex.js'));
  const P = { suffixParts: C.COMPLEX_PARTS };
  const groups = (muts) => A.analyze(C.complexRows(muts), P).bases[0];

  const plain = groups();
  checks.push(['複雑な SQL でもコピー展開なら 1 グループ', plain.groupCount === 1]);
  checks.push(['複雑な SQL のパラメータは実体名と値だけ',
    plain.groups[0].params.every((p) => ['entity', 'string', 'number'].includes(p.kind))]);
  checks.push(['複雑な SQL で参照先が全部パラメータになる',
    plain.groups[0].params.filter((p) => p.kind === 'entity').length >= 4]);
  checks.push(['suffix と連動する国コードもパラメータになる',
    plain.groups[0].params.some((p) => p.kind === 'string' &&
      Object.values(p.values).join(',') === "'JP','UK','US'")]);

  // 差を入れたら割れること。理由まで見て、意図した検出かを確かめる。
  const split = (label, mutate, reason, kind) => {
    const b = groups({ abus: mutate });
    const g = b.groups.find((x) => x.miss);
    const okReason = !reason || (g && g.miss.detail.reason === reason);
    const okKind = !kind || (g && g.miss.detail.kind === kind);
    checks.push([`複雑な SQL: ${label}`, b.groupCount === 2 && okReason && okKind]);
  };
  split('列名を変えると割れる',
    (q) => q.replace('AS gross_amount', 'AS total_amount'), 'not-substitutable', 'ident');
  split('CTE 名を変えると割れる',
    (q) => q.split('daily').join('dly'), 'not-substitutable', 'ident');
  split('別名を変えると割れる',
    (q) => q.replace('AS o\n', 'AS ord\n'), 'not-substitutable', 'ident');
  split('ウィンドウ名を変えると割れる',
    (q) => q.split(' w ').join(' win ').replace('OVER w\n', 'OVER win\n'),
    'not-substitutable', 'ident');
  split('集約関数を変えると割れる',
    (q) => q.replace('COUNT(DISTINCT r.order_id)', 'COUNT(r.order_id)'), 'length');
  split('JOIN 種別を変えると割れる',
    (q) => q.replace('LEFT JOIN', 'INNER JOIN'), 'not-substitutable', 'keyword');
  split('条件を 1 本足すと割れる',
    (q) => q.replace("AND o.status = 'CONFIRMED'",
      "AND o.status = 'CONFIRMED'\n    AND o.is_test = FALSE"), 'length');
  split('バッククォートを外すと割れる',
    (q) => q.replace('`PRJ.ref_abus.calendar_abus`', 'PRJ.ref_abus.calendar_abus'), 'length');

  // 方針どおり「同じグループのまま」になるもの。
  // 差が消えるわけではなく、パラメータ一覧に出る。
  const merged = (label, mutate, paramValue) => {
    const b = groups({ abus: mutate });
    const shown = JSON.stringify(b.groups[0] && b.groups[0].params);
    checks.push([`複雑な SQL: ${label}`,
      b.groupCount === 1 && (!paramValue || shown.includes(paramValue))]);
  };
  merged('しきい値の差は値としてパラメータ化する',
    (q) => q.replace('>= 10000', '>= 20000'), '20000');
  merged('参照先の差は実体名としてパラメータ化する',
    (q) => q.replace('returns_abus', 'refunds_abus'), 'refunds_abus');
  merged('IF の条件値の差もパラメータ化する',
    (q) => q.replace('>= 5000', '>= 8000'), '8000');
  merged('IN リストの中身の差もパラメータ化する',
    (q) => q.replace("'WEB', 'STORE'", "'ONLINE', 'SHOP'"), "'ONLINE'");
  split('IN リストの要素が増えると割れる',
    (q) => q.replace("'WEB', 'STORE'", "'WEB', 'STORE', 'PHONE'"), 'length');
  split('CASE の WHEN が増えると割れる',
    (q) => q.replace("WHEN o.amount >= 1000  THEN 'MEDIUM'",
      "WHEN o.amount >= 5000 THEN 'UPPER'\n      WHEN o.amount >= 1000  THEN 'MEDIUM'"),
    'length');

  // 実体名の検出。取りこぼすと誤って割れ、拾いすぎると差を見逃す。
  const ents = A.markEntities(A.tokenizeSql(C.complexSql('abjp')))
    .filter((t) => t.kind === 'entity').map((t) => t.text);
  checks.push(['複雑な SQL: バッククォートの参照を拾う',
    ents.includes('`PRJ.mart_abjp.orders_abjp`') &&
    ents.includes('`PRJ.ref_abjp.calendar_abjp`')]);
  checks.push(['複雑な SQL: 裸の参照もドット区切りで拾う',
    ents.includes('mart_abjp') && ents.includes('returns_abjp')]);
  checks.push(['複雑な SQL: 相関サブクエリの中の参照も拾う',
    ents.includes('`PRJ.mart_abjp.customers_abjp`')]);
  checks.push(['複雑な SQL: UNNEST を実体名にしない', !ents.includes('UNNEST')]);
  checks.push(['複雑な SQL: 別名を実体名にしない',
    !ents.includes('o') && !ents.includes('cal') && !ents.includes('rt')]);
  checks.push(['複雑な SQL: 列名を実体名にしない',
    !ents.includes('order_date') && !ents.includes('gross_amount')]);
}

// カンマで並べたソースの取りこぼし（FROM a AS x, b AS y の b）
// 別名を読み飛ばさないと 2 つ目以降にたどり着けない。suffix の伏せ字が
// 効いていると症状が隠れるので、伏せ字を切って確かめる。
{
  const P = { suffixParts: [['ab'], ['jp', 'us']], suffixAware: false };
  const two = (a, b) => A.analyze(
    [{ view_name: 'v_c_abjp', ddl: a }, { view_name: 'v_c_abus', ddl: b }], P
  ).bases[0].groupCount;
  checks.push(['FROM a AS x, b AS y の 2 つ目も実体名として拾う',
    two('SELECT 1 FROM t_abjp AS x, u_abjp AS y',
        'SELECT 1 FROM t_abus AS x, u_abus AS y') === 1]);
  checks.push(['AS を省いた別名でも 2 つ目を拾う',
    two('SELECT 1 FROM t_abjp x, u_abjp y',
        'SELECT 1 FROM t_abus x, u_abus y') === 1]);
  checks.push(['3 つ並べても全部拾う',
    two('SELECT 1 FROM a_abjp AS x, b_abjp AS y, c_abjp AS z',
        'SELECT 1 FROM a_abus AS x, b_abus AS y, c_abus AS z') === 1]);
  checks.push(['suffix と無関係な名前でも拾う',
    A.analyze([
      { view_name: 'v_c_abjp', ddl: 'SELECT 1 FROM t_abjp AS x, ref_alpha AS y' },
      { view_name: 'v_c_abus', ddl: 'SELECT 1 FROM t_abus AS x, ref_beta AS y' },
    ], { suffixParts: [['ab'], ['jp', 'us']] }).bases[0].groupCount === 1]);
}

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
