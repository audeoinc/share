// render_groups.js のプレビュー兼検証。
//   node preview.mjs         dist/preview.html を生成して検証
//   node preview.mjs --check 生成せず検証だけ
//
// サンプル（3 グループ）に加えて、2 / 1 / 5 グループのケースも作って
// レイアウトの切り替わりを確認する。
import { writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const A = require(join(here, 'analyze.js'));
const S = require(join(here, 'sample_views.js'));
const R = require(join(here, 'render_groups.js'));

const OPTS = { suffixParts: S.SUFFIX_PARTS };

// --- ケースを組み立てる -------------------------------------------------
const base3 = A.analyze(S.sampleRows(), OPTS).bases[0];              // 3 グループ

const rows2 = S.sampleRows().filter((r) => !r.view_name.includes('_ef'));
const base2 = A.analyze(rows2, OPTS).bases[0];                       // 2 グループ

const rows1 = S.sampleRows().filter((r) => r.view_name.includes('_ab'));
const base1 = A.analyze(rows1, OPTS).bases[0];                       // 1 グループ

// 5 グループ: ab 系を土台に、WHERE 条件を少しずつ変えた系統を足す
const many = S.sampleRows().slice();
const tmpl = many.find((r) => r.view_name.endsWith('_abjp')).ddl;
for (const [suf, extra] of [['cdjp', 'AND o.status = \'CONFIRMED\''],
  ['cdus', 'AND o.status = \'CONFIRMED\''],
  ['cduk', 'AND o.status = \'CONFIRMED\'']]) {
  const i = many.findIndex((r) => r.view_name.endsWith('_' + suf));
  many[i] = { view_name: many[i].view_name, ddl: tmpl.replace(/_abjp/g, '_' + suf) };
}
many.push(
  { view_name: 'v_daily_sales_ghjp', ddl: tmpl.replace(/_abjp/g, '_ghjp').replace('GROUP BY o.order_date, o.region', 'GROUP BY o.order_date') },
  { view_name: 'v_daily_sales_ghus', ddl: tmpl.replace(/_abjp/g, '_ghus').replace('GROUP BY o.order_date, o.region', 'GROUP BY o.order_date') },
  { view_name: 'v_daily_sales_ijjp', ddl: tmpl.replace(/_abjp/g, '_ijjp').replace('COUNT(DISTINCT o.order_id)', 'COUNT(o.order_id)') },
);
const baseMany = A.analyze(many, {
  suffixParts: [['ab', 'cd', 'ef', 'gh', 'ij'], ['jp', 'us', 'uk']],
}).bases[0];

// suffix を認識できなかった View（単独表示）
const baseOdd = A.analyze([
  { view_name: 'v_legacy_report',
    ddl: 'SELECT\n  order_date,\n  SUM(amount) AS amount\nFROM `p.legacy.orders`\nGROUP BY order_date' },
], OPTS).bases[0];

// 複雑な SQL（多段 CTE / 名前付きウィンドウ / QUALIFY / UNION / UNNEST /
// 相関サブクエリ）。1 本だけ列名を変えて、実際の差分表示を目で見られるようにする。
const C = require(join(here, 'sample_complex.js'));
const baseComplex = A.analyze(
  C.complexRows({ abus: (q) => q.replace('AS gross_amount', 'AS total_amount') }),
  { suffixParts: C.COMPLEX_PARTS }
).bases[0];

const cases = [
  { title: '3 グループ（既定 = タブ）', b: base3, opts: {} },
  { title: '2 グループ（基準 ＋ 比較 1 枚）', b: base2, opts: {} },
  { title: '1 グループ（基準タブのみ）', b: base1, opts: {} },
  { title: `${baseMany.groupCount} グループ（既定 = タブ）`, b: baseMany, opts: {} },
  { title: 'suffix 未認識（単独表示）', b: baseOdd, opts: {} },
  { title: '複雑な SQL（多段 CTE / ウィンドウ / UNION）', b: baseComplex, opts: {} },
];

const parts = cases.map((c) => ({ ...c, html: R.renderBase(c.b, c.opts) }));

// --- 検証 --------------------------------------------------------------
const h3 = parts[0].html;
const h1 = parts[2].html;
const hMany = parts[3].html;
const hOdd = parts[4].html;

const idsOf = (h) => [...h.matchAll(/id="([^"]+)"/g)].map((m) => m[1]);
const checks = [
  ['タイトルが base 名', h3.includes('v_daily_sales')],
  ['グループ数バッジが出る', h3.includes('3 グループ')],
  ['ペイン見出しに suffix が列記される', h3.replace(/<[^>]*>/g, '').includes('abjp, abuk, abus')],
  ['3 グループは既定でタブ', h3.includes('vg-tablist')],
  ['タブは基準を含めて 3 枚', (h3.match(/class="vg-tab /g) || []).length === 3],
  ['タブの枚数がグループ数と一致する',
    (h3.match(/class="vg-tab /g) || []).length === base3.groupCount &&
    (hMany.match(/class="vg-tab /g) || []).length === baseMany.groupCount],
  ['タブ見出しに suffix が列記される',
    ['cdjp, cduk, cdus', 'efjp, efuk, efus']
      .every((s) => h3.replace(/<[^>]*>/g, '').includes(s))],
  ['3 ペイン横並びは出さない（タブのみ）',
    !parts.map((p) => p.html).join('').includes('reference')],
  ['4 グループ以上もタブ', hMany.includes('vg-tablist') && baseMany.groupCount > 3],
  ['基準タブが選択状態で固定されている',
    hMany.includes('vg-tbase') && !/vg-tbase[^>]*for=/.test(hMany)],
  ['1 グループは差分なしの案内', h1.includes('すべてが同一ロジック')],
  // 比較相手がいないので、同じ SQL を左右に並べない
  ['1 グループはペインが 1 枚', (h1.match(/<th colspan=/g) || []).length === 1],
  ['1 グループでも基準タブが 1 枚出る',
    (h1.match(/class="vg-tab /g) || []).length === 1 && h1.includes('vg-tbase')],
  ['3 グループはペインが 2 枚', (h3.match(/<th colspan=/g) || []).length === 2 * 2],
  ['1 グループでも SQL は出る', h1.replace(/<[^>]*>/g, '').includes('SELECT')],
  ['1 グループに差分マーカーが出ない', !/[+−]<\/td>/.test(h1)],
  ['パラメータ一覧が出る', h3.includes('パラメータ化した箇所')],
  ['パラメータ値に suffix が並ぶ', h3.includes('vg-psuf')],
  ['radio の id が一意',
    new Set(idsOf(h3)).size === idsOf(h3).length && idsOf(h3).length > 0],
  // 宣言ブロックには 16 進カラーの # が入るので、セレクタ部分だけを見る
  ['CSS が id を参照していない（静的に保てる）',
    R.chromeCss().split('\n')
      .map((line) => line.split('{')[0])
      .every((sel) => !sel.includes('#'))],
  ['タブ CSS が MAX_TABS 分ある',
    (R.chromeCss().match(/\.vg-r\d+:checked ~ \.vg-panels/g) || []).length === R.MAX_TABS],
  ['script タグを含まない', !/<script/i.test(parts.map((p) => p.html).join(''))],
  ['誤解を招く副題 (after)/(reference) が残っていない',
    !/\((?:before|after|base|reference)\)/.test(parts.map((p) => p.html).join(''))],
  ['副題が View 数になっている', h3.includes('基準 / 3 View')],
  ['2 グループもタブ（基準 ＋ 比較相手の 2 枚）',
    (parts[1].html.match(/class="vg-tab /g) || []).length === 2],
  ['なぜ別グループになったかを出す', h3.includes('なぜ別グループになったか')],
  ['未認識の View はタイトルが View 名', hOdd.includes('v_legacy_report')],
  ['未認識の View にバッジが付く', hOdd.includes('suffix 未認識')],
  ['未認識の View もソースを描く', hOdd.replace(/<[^>]*>/g, '').includes('legacy')],
  ['未認識の見出しは空にならない',
    !hOdd.includes('<div class="vg-plabel"></div>')],
  // suffix と連動する 'JP'/'US' は吸収されるので、連動しない値で割る
  ['リテラル差で割れたときは substitutable の指定を案内する',
    R.renderBase(A.analyze([
      { view_name: 'v_x_abjp', ddl: "SELECT a FROM t_abjp WHERE s = 'A'" },
      { view_name: 'v_x_abus', ddl: "SELECT a FROM t_abus WHERE s = 'B'" },
    ], { suffixParts: [['ab'], ['jp', 'us']], substitutable: ['entity'] }).bases[0], {})
      .includes('substitutable')],
  ['suffix と連動するリテラルは割らない',
    A.analyze([
      { view_name: 'v_x_abjp', ddl: "SELECT a FROM t_abjp WHERE c = 'JP'" },
      { view_name: 'v_x_abus', ddl: "SELECT a FROM t_abus WHERE c = 'US'" },
    ], { suffixParts: [['ab'], ['jp', 'us']] }).bases[0].groupCount === 1],
  ['同値リテラルの案内を出す',
    R.renderBase(A.analyze([
      { view_name: 'v_v_abjp', ddl: "SELECT a FROM t_abjp WHERE z = 'apac'" },
      { view_name: 'v_v_abus', ddl: "SELECT a FROM t_abus WHERE z = 'amer'" },
    ], { suffixParts: [['ab'], ['jp', 'us']], substitutable: ['entity'] }).bases[0], {})
      .includes('equivalentLiterals')],
  ['複雑な SQL も描ける',
    parts[5].html.includes('vg-root') &&
    parts[5].html.replace(/<[^>]*>/g, '').includes('QUALIFY')],
  ['複雑な SQL は 2 グループでタブが 2 枚',
    baseComplex.groupCount === 2 &&
    (parts[5].html.match(/class="vg-tab /g) || []).length === 2],
  ['複雑な SQL のパラメータに実体名の種別が出る',
    parts[5].html.includes('実体名')],
  // --- パラメータの tooltip ---------------------------------------------
  ['パラメータの目印に tooltip が付く', h3.includes('data-tip="P1: ')],
  ['tooltip に種別と suffix ごとの値が並ぶ',
    /data-tip="P1: [^"]*\n[a-z]+ = /.test(h3)],
  ['tooltip の中身は属性に置く（CSS 未適用でも本文に流れ出さない）',
    !/>P1: /.test(h3)],
  ['右ペインの吹き出しは右寄せにする', h3.includes('class="vg-ph vg-phr"')],
  ['tooltip の CSS が chrome 側にある',
    R.chromeCss().includes('.vg-ph::after{content:attr(data-tip)') &&
    R.chromeCss().includes('.vg-ph:hover::after')],
  ['目印がチップとして目立つ（紫の地色）',
    /\.vg-ph\{[^}]*background:#F1E8FD[^}]*color:#6639BA/.test(R.chromeCss())],
  ['チップの枠は border ではなく inset の box-shadow（桁がずれない）',
    /\.vg-ph\{[^}]*box-shadow:inset/.test(R.chromeCss()) &&
    !/\.vg-ph\{[^}]*border:/.test(R.chromeCss())],
  ['チップの padding を負の margin で打ち消している（桁がずれない）', (() => {
    const m = R.chromeCss().match(/\.vg-ph\{([^}]*)\}/);
    const pad = m && m[1].match(/padding:0 (\d+)px/);
    const mar = m && m[1].match(/margin:0 -(\d+)px/);
    return !!(pad && mar && pad[1] === mar[1]);
  })()],
  ['すべての目印に tooltip が付く（タグで割れた分も含む）', (() => {
    // 行内差分は語単位で切るので、値が違う位置では {{ と P1 の間にタグが入る。
    // 左右でパラメータ名の振られ方がずれる形を作って、その経路も通す。
    const b = A.analyze([
      { view_name: 'v_y_abjp', ddl: "SELECT 'X' AS k FROM t_abjp" },
      { view_name: 'v_y_abus', ddl: "SELECT 'Y' AS k FROM t_abus" },
      { view_name: 'v_y_cdjp', ddl: "SELECT 'Z' AS k, b FROM t_cdjp" },
      { view_name: 'v_y_cdus', ddl: "SELECT 'Z' AS k, b FROM t_cdus" },
    ], { suffixParts: [['ab', 'cd'], ['jp', 'us']] }).bases[0];
    const h = R.renderBase(b, {});
    const marks = h.match(/\{(?:<[^>]+>)*\{(?:<[^>]+>)*P\d+(?:<[^>]+>)*\}(?:<[^>]+>)*\}/g) || [];
    return marks.length === 3 && marks.some((m) => m.includes('<')) &&
      (h.match(/class="vg-ph/g) || []).length === marks.length;
  })()],
  ['左右のペインで別の対応表を使う', (() => {
    // パラメータ名はグループごとに振り直すので、同じ P1 でも左右で中身が違う
    const tips = [...parts[0].html.matchAll(/data-tip="(P1: [^"]*)"/g)].map((m) => m[1]);
    return new Set(tips).size > 1;
  })()],
  ['伏せ字は診断で見える表記に戻す',
    R.renderBase(A.analyze([
      { view_name: 'v_w_abjp', ddl: "SELECT a FROM t WHERE c = 'abjp'" },
      { view_name: 'v_w_abus', ddl: "SELECT a FROM t WHERE c = 'zz'" },
    ], { suffixParts: [['ab'], ['jp', 'us']], substitutable: ['entity'] }).bases[0], {})
      .includes('\u27e8suffix\u27e9')],
];

let failed = 0;
for (const [name, ok] of checks) {
  if (!ok) failed++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}`);
}
console.log(`\n${checks.length - failed}/${checks.length} passed`);

if (!process.argv.includes('--check')) {
  const { chromeCss } = R;
  // 差分表の CSS は render.js がインラインで出しているので、ここでは chrome だけ
  const page = '<!doctype html>\n<html lang="ja">\n<head>\n<meta charset="utf-8">\n' +
    '<title>view groups preview</title>\n<style>\nbody{margin:16px;background:#fff}\n' +
    'h2{font:600 14px/1.6 Roboto,system-ui,sans-serif;color:#57606A;' +
    'margin:32px 0 12px;padding-top:16px;border-top:1px solid #D0D7DE}\n' +
    chromeCss() + '\n</style>\n</head>\n<body>\n' +
    parts.map((p) => `<h2>${p.title}</h2>\n${p.html}`).join('\n') +
    '\n</body>\n</html>\n';
  await mkdir(join(here, 'dist'), { recursive: true });
  const out = join(here, 'dist', 'preview.html');
  await writeFile(out, page);
  console.log(`wrote ${out}`);
}

process.exit(failed === 0 ? 0 : 1);
