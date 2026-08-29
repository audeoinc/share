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
const E = require(join(here, 'erd.js'));
const Ch = require(join(here, 'chrome.js'));
const Md = require(join(here, 'markdown.js'));
const Co = require(join(here, 'columns.js'));

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

// base ごとのメモ。カードのいちばん左のタブに出る。
// Confluence から移ってくる書き方（見出し・表・箇条書き・コード・引用）を
// ひととおり入れて、CSS が全部そろっているかを目で見られるようにする。
const NOTE_MD = [
  '# v_daily_sales について',
  '',
  '各リージョンの日次売上。**jp だけ税込** で、ほかは税抜き。',
  '詳細は [設計メモ](https://example.com/design?id=1&rev=2) を参照。',
  '',
  '## 参照元',
  '',
  '| suffix | 参照元 | 更新 | 備考 |',
  '|:--|:--|:-:|--:|',
  '| abjp | `orders_abjp` | 03:00 | 税込 |',
  '| abus | `orders_abus` | 04:00 | — |',
  '',
  '## 注意点',
  '',
  '- 一次集計は CTE `daily` で行う',
  '  - `region` は 2 段目で付与する',
  '  - 列名 `gross_amount` は 2026-04 に変更予定',
  '- 月次との突き合わせは `v_monthly_sales_*` を見る',
  '',
  '1. 抽出',
  '2. 集計',
  '3. 出力',
  '',
  '> 廃止予定: ~~`v_daily_sales_zzjp`~~ は 2026-06 に削除済み。',
  '',
  '```sql',
  "SELECT * FROM `prj.mart_abjp.orders_abjp` WHERE order_date = CURRENT_DATE()",
  '```',
  '',
  '---',
  '',
  'snake_case_name は斜体にしない。',
].join('\n');

const memoCases = [
  { title: 'メモ（Markdown）', html: Md.markdownHtml(NOTE_MD) },
  { title: 'メモ（未登録）', html: Md.markdownHtml(null) },
];

// カラム定義の代わり。実際は INFORMATION_SCHEMA.COLUMNS から作った並びが来る。
// 同じグループの中で型が割れる場合（jp は NUMERIC・us は FLOAT64）と、
// グループによって列が無い場合の両方を入れて、印の出方を目で見られるようにする。
const fakeColumns = (b) => {
  const out = {};
  for (const g of b.groups) {
    g.members.forEach((m, i) => {
      const suffix = g.suffixes[i] || m.viewName;
      const cols = [
        { n: 'order_date', t: 'DATE', o: 1, u: 'NO', d: '受注日（JST）' },
        { n: 'region', t: 'STRING', o: 2, u: 'YES', d: 'リージョン コード。jp / us / uk' },
        // グループ間で型が違う例。同じ列名で片方だけ NUMERIC。
        { n: 'order_count', t: g === b.groups[1] ? 'NUMERIC' : 'INT64', o: 3, u: 'YES', d: '' },
        { n: 'gross_amount', t: /us$/.test(suffix) ? 'FLOAT64' : 'NUMERIC', o: 4,
          u: /uk$/.test(suffix) ? 'NO' : 'YES',
          d: '税抜き。参照先テーブルの型に引きずられる' },
      ];
      // 先頭以外のグループには列を 1 本足す／落とす
      if (g !== b.groups[0]) cols.push({ n: 'currency', t: 'STRING', o: cols.length + 1, u: 'YES', d: '通貨コード' });
      if (g === b.groups[b.groups.length - 1]) cols.splice(1, 1);
      out[m.viewName] = cols;
    });
  }
  return out;
};

// 実際に Looker へ渡すのは、差分と参照関係を外側タブで束ねた 1 枚。
// プレビューの先頭にその形も置いて、束ねた状態で崩れないかを見る。
// メモは作り置きせず、ビューが REPLACE で差し込む（シートを直した内容を
// その場で出すため）。ここでも同じ置換をして、実物と同じ形を見る。
const splice = (html, note) => html.replace(Ch.NOTE_MARK, note);

const pageCases = [
  { title: '外側タブ（note / ロジック差分 / 参照関係）', b: baseComplex, opts: {},
    note: NOTE_MD },
  { title: '外側タブ・3 グループ', b: base3, opts: {}, note: NOTE_MD },
  { title: '外側タブ・メモが未登録の base', b: base2, opts: {}, note: null },
].map((c) => ({ ...c,
  html: splice(
    Ch.wrapPage(R.renderBase(c.b, c.opts), E.renderErdBase(c.b),
      Co.renderColumnsBase(c.b, fakeColumns(c.b)), c.b),
    Md.markdownHtml(c.note)) }));

const columnCases = [
  { title: 'カラム定義（型が割れているグループあり）',
    html: Co.renderColumnsBase(base3, fakeColumns(base3)) },
  { title: 'カラム定義（取得できなかった場合）',
    html: Co.renderColumnsBase(base3, {}) },
];

// --- 検証 --------------------------------------------------------------
const h3 = parts[0].html;
const h1 = parts[2].html;
const hMany = parts[3].html;
const hOdd = parts[4].html;

const idsOf = (h) => [...h.matchAll(/id="([^"]+)"/g)].map((m) => m[1]);
// これまでに配った外枠の世代。テンプレートの CSS は手貼り、カードは日次生成
// なので、どの世代のカードが入っていても同じ CSS で効かないといけない。
// 片方を決め打ちにしたせいで実機の「タブが反転しない」を二度出している。
const CARD_GENERATIONS = [
  ['.vg-otablist > ', '見出しがパネルの中／帯の中'],
  ['.vg-ohead > .vg-otablist > ', '見出しを .vg-ohead で包んだ世代'],
];
// 外側タブの規則が、全世代ぶん「兄弟 > 子」で書けているか。
// 子孫結合子と * は使わない（この viz で動くと確認できているのは子結合子）。
const OUTER_TABS_OK = (css) => Ch.OUTER_TABS.every((_, i) =>
  CARD_GENERATIONS.every(([path]) =>
    css.includes(`.vg-or${i + 1}:checked ~ ${path}.vg-ot${i + 1}`))) &&
  !/:checked ~ [^,{]*\*/.test(css) &&
  !/:checked ~ \.vg-ohead \./.test(css);
const checks = [
  ['タイトルが base 名', h3.includes('v_daily_sales')],
  ['グループ数バッジが出る', h3.includes('3 グループ')],
  ['ペイン見出しに suffix が列記される', h3.replace(/<[^>]*>/g, '').includes('abjp, abuk, abus')],
  ['3 グループは既定でタブ', h3.includes('vg-tablist')],
  // 基準はカードの中で選ぶ（レコードは base ごとに 1 行）。基準ごとに
  // 比較タブがグループ数ぶんできるので、比較タブは G×G 枚になる。
  ['基準タブがグループ数ぶん出る',
    (h3.match(/class="vg-btab /g) || []).length === base3.groupCount &&
    (h3.match(/class="vg-bpanel /g) || []).length === base3.groupCount],
  ['基準ごとの比較タブがグループ数と一致する',
    (h3.match(/class="vg-tab /g) || []).length === base3.groupCount ** 2 &&
    (hMany.match(/class="vg-tab /g) || []).length === baseMany.groupCount ** 2],
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
  ['3 グループは基準ごとに 2 ペイン（全部で G×(G-1) 組）',
    (h3.match(/<th colspan=/g) || []).length ===
      2 * base3.groupCount * (base3.groupCount - 1)],
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
  ['script タグを含まない',
    !/<script/i.test(parts.concat(pageCases).map((p) => p.html).join(''))],
  ['誤解を招く副題 (after)/(reference) が残っていない',
    !/\((?:before|after|base|reference)\)/.test(parts.map((p) => p.html).join(''))],
  ['副題が View 数になっている', h3.includes('基準 / 3 View')],
  ['2 グループもタブ（基準 2 枚 × 比較 2 枚）',
    (parts[1].html.match(/class="vg-btab /g) || []).length === 2 &&
    (parts[1].html.match(/class="vg-tab /g) || []).length === 4],
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
  ['複雑な SQL は 2 グループで比較タブが 4 枚（2 基準 × 2）',
    baseComplex.groupCount === 2 &&
    (parts[5].html.match(/class="vg-tab /g) || []).length === 4],
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
    // 基準ごとに同じ比較がもう一度出るので、目印の数はグループ数ぶん増える
    const h = R.renderBase(b, {});
    const marks = h.match(/\{(?:<[^>]+>)*\{(?:<[^>]+>)*P\d+(?:<[^>]+>)*\}(?:<[^>]+>)*\}/g) || [];
    return marks.length === 3 * b.groups.length && marks.some((m) => m.includes('<')) &&
      (h.match(/class="vg-ph/g) || []).length === marks.length;
  })()],
  ['左右のペインで別の対応表を使う', (() => {
    // パラメータ名はグループごとに振り直すので、同じ P1 でも左右で中身が違う
    const tips = [...parts[0].html.matchAll(/data-tip="(P1: [^"]*)"/g)].map((m) => m[1]);
    return new Set(tips).size > 1;
  })()],
  // --- 基準の切り替え -----------------------------------------------
  ['基準タブの見出しがグループの並びどおり', (() => {
    const names = [...h3.matchAll(/class="vg-btab vg-bt\d+"[^>]*>([^<]*)/g)].map((m) => m[1]);
    return names.join(' | ') === base3.groups.map(Ch.label).join(' | ');
  })()],
  ['基準パネルごとに左ペインが入れ替わる', (() => {
    // 各基準パネルの先頭の「基準」タブが、その基準のグループになっている
    const panels = h3.split('<div class="vg-bpanel ').slice(1);
    return panels.length === base3.groupCount && panels.every((p, i) =>
      p.indexOf(`基準</span>${Ch.label(base3.groups[i])}`) > 0);
  })()],
  ['基準パネルはどれも同じ枚数の比較を持つ', (() => {
    const panels = h3.split('<div class="vg-bpanel ').slice(1);
    const panes = (p) => (p.match(/<th colspan=/g) || []).length;
    return panels.every((p) => panes(p) === 2 * (base3.groupCount - 1));
  })()],
  ['「なぜ別グループになったか」が基準パネルごとの向きになる', (() => {
    const panels = h3.split('<div class="vg-bpanel ').slice(1);
    return panels.every((p, i) => {
      const vs = [...p.matchAll(/class="vg-mvs">vs ([^<]*)</g)].map((m) => m[1]);
      // 全部その基準に対する差で、基準そのものは並ばない
      return vs.length === base3.groupCount - 1 &&
        vs.every((v) => v === Ch.label(base3.groups[i]));
    });
  })()],
  ['基準パネルごとにラジオの名前を分ける（他の基準の比較タブが開かなくなる）', (() => {
    const names = [...h3.matchAll(/class="vg-r vg-r1" type="radio" name="([^"]+)"/g)]
      .map((m) => m[1]);
    return names.length === base3.groupCount && new Set(names).size === names.length;
  })()],
  ['解析は全順序対の差を持つ（基準ごとに出し分けられる）',
    base3.groups.every((g, i) => g.missBy.length === base3.groupCount &&
      g.missBy[i] === null &&
      g.missBy.filter((m) => m).length === base3.groupCount - 1)],
  // --- 参照関係（ERD） --------------------------------------------------
  ['外側タブが 4 枚出る（note / カラム定義 / ロジック差分 / 参照関係）',
    (pageCases[0].html.match(/class="vg-otab /g) || []).length === Ch.OUTER_TABS.length &&
    Ch.OUTER_TABS.join(',') === 'note,カラム定義,ロジック差分,参照関係'],
  ['既定で開くのはいちばん左のメモ タブ', (() => {
    const h = pageCases[0].html;
    // checked が付くのは 1 枚目だけ。外側タブの CSS も 1 枚目を開く形になる。
    return /class="vg-or vg-or1" type="radio" name="[^"]*" id="[^"]*-1" checked>/.test(h) &&
      !/vg-or(2|3)" type="radio"[^>]*checked/.test(h) &&
      R.chromeCss().includes('.vg-or1:checked ~ .vg-opanels > .vg-op1{display:block}');
  })()],
  ['メモは作り置きせずビューが差し込む（目印が残っている）', (() => {
    const raw = Ch.wrapPage('<i>D</i>', '<i>E</i>', 'x');
    return raw.split(Ch.NOTE_MARK).length - 1 === 1 &&
      !raw.includes('vg-md') &&
      // 置換したあとは目印が消え、メモ本体が 1 枚目のパネルに入る
      pageCases[0].html.indexOf('vg-md') > pageCases[0].html.indexOf('vg-opanel vg-op1') &&
      pageCases[0].html.indexOf('vg-md') < pageCases[0].html.indexOf('vg-opanel vg-op2') &&
      !pageCases[0].html.includes(Ch.NOTE_MARK);
  })()],
  // sticky はいちばん近いスクロールする祖先が基準。埋め込み先の overflow に
  // 左右されないよう、カード自身をスクロールする箱にしておく。
  // 埋め込み先まかせにすると、overflow:hidden の祖先や、中身の高さぶん伸びる
  // iframe（＝中にスクロールする要素が無い）で効かない。固定の px を上限に
  // 入れておけば、どの形でもこの箱がスクロールする側になる。
  ['カードが自前のスクロール箱になっている（sticky の基準を自分で持つ）',
    /\.vg-outer\{max-height:min\(100vh,\d+px\);overflow:auto\}/.test(R.chromeCss())],
  ['見出しはタブと同じ帯にあり、どのタブでも見える', (() => {
    const h = pageCases[0].html;
    const head = h.slice(h.indexOf('<div class="vg-otablist">'), h.indexOf('<div class="vg-opanels">'));
    // 帯の中に見出しとタブが揃っていること
    return head.includes(`<span class="vg-title">${baseComplex.base}<`) &&
      (head.match(/vg-badge/g) || []).length === 2 &&
      (head.match(/class="vg-otab /g) || []).length === Ch.OUTER_TABS.length &&
      // パネル側の見出しは CSS で隠す（単体で使うときのために markup は残す）
      R.chromeCss().includes('.vg-opanel .vg-header{display:none}');
  })()],
  ['帯ごとスクロールに追従する（見出し＋タブ・全世代）',
    /\.vg-otablist,\.vg-ohead\{[^}]*position:sticky[^}]*top:0/.test(R.chromeCss())],
  // 選択中のタブを塗る規則は「兄弟 > 子」から動かさない。この viz で
  // radio + :checked が動くと確かめたときの形がこれで（templated_record/
  // samples/07_radio_tabs_test.html）、子孫に変えたら実機で反転しなくなった。
  // 見出しを別の入れ物で包むと子孫になるので、包まないことも合わせて見る。
  ['選択中のタブを塗る規則が、配った全世代のカードで効く形になっている', (() => {
    const css = R.chromeCss();
    return OUTER_TABS_OK(css) &&
      css.includes('.vg-or2:checked ~ .vg-opanels > .vg-op2{display:block}') &&
      // 見出しは帯の中の直接の子。包む入れ物を挟むと上の形が崩れる
      /<div class="vg-otablist"><div class="vg-header">/.test(pageCases[0].html) &&
      !pageCases[0].html.includes('vg-ohead');
  })()],
  ['メモが未登録でもタブは出る（中身が未登録の枠になる）',
    (pageCases[2].html.match(/class="vg-otab /g) || []).length === Ch.OUTER_TABS.length &&
    pageCases[2].html.includes('vg-mdempty')],
  ['外側と内側でラジオのクラスを分けている（片方を押しても連動しない）',
    /class="vg-or vg-or1"/.test(pageCases[0].html) &&
    !/class="vg-r vg-or/.test(pageCases[0].html)],
  ['参照関係が SVG で描かれる（グループの数だけ）',
    (pageCases[0].html.match(/<svg /g) || []).length === baseComplex.groupCount],
  ['SVG は style 属性を使わない（class モードでクラスが増えない）',
    !/<(svg|rect|path|text|g|marker)[^>]*\sstyle=/.test(pageCases[0].html)],
  ['実テーブルも CTE も節になる', (() => {
    const g = E.buildGraph(baseComplex.groups[0].sql, baseComplex.groups[0].params);
    const kinds = new Set(g.nodes.map((n) => n.kind));
    return kinds.has('table') && kinds.has('cte') && kinds.has('output');
  })()],
  ['サブクエリの中の参照も拾う（EXISTS の相関サブクエリ）', (() => {
    const g = E.buildGraph(baseComplex.groups[0].sql, baseComplex.groups[0].params);
    const n = g.nodes.find((x) => /customers/.test(x.label));
    if (!n) return false;
    return g.edges.some((e) => e.from === n.id && e.nested);
  })()],
  ['JOIN の種別と結合キーが辺に付く', (() => {
    const g = E.buildGraph(baseComplex.groups[0].sql, baseComplex.groups[0].params);
    return g.edges.some((e) => e.joinType === 'LEFT' && e.keys.indexOf('order_date') >= 0);
  })()],
  ['どの辺も 1 段しかまたがない（箱の上を横切らない）', (() => {
    const lay = E.layout(E.buildGraph(baseComplex.groups[0].sql, baseComplex.groups[0].params));
    // 段の x は溝の幅ぶんまちまちなので、実際に置かれた列で数える
    const xs = [...new Set(lay.nodes.map((n) => n.x))].sort((a, b) => a - b);
    const col = (x) => xs.indexOf(x);
    return lay.edges.every((e) => col(e.b.x) - col(e.a.x) === 1);
  })()],
  ['辺の注記を省略しない（溝を注記の幅に合わせる）', (() => {
    // 結合キーが長くても、詰めずに溝を広げて全部出す
    const sql = 'WITH d AS (SELECT o.id FROM `p.m.orders` AS o ' +
      'LEFT JOIN `p.m.customers` AS c ' +
      'ON o.customer_identifier = c.external_customer_id) SELECT * FROM d';
    const lay = E.layout(E.buildGraph(sql, []));
    const svg = E.toSvg(lay);
    return svg.includes('customer_identifier = external_customer_id') &&
      !svg.includes('…') &&
      Math.max(...lay.gaps) > 200;
  })()],
  ['注記は JOIN 種別と結合キーを行に分ける',
    JSON.stringify(E.edgeLines({ joinType: 'LEFT', keys: ['a', 'b'] })) ===
      JSON.stringify(['LEFT JOIN', 'a', 'b'])],
  ['箱もいちばん長い名前に合わせて広げる', (() => {
    const sql = 'SELECT x FROM `p.m.a_very_long_source_table_name`';
    const lay = E.layout(E.buildGraph(sql, []));
    return lay.nodes.every((n) => n.w > E.BOX_W_MIN) &&
      !E.toSvg(lay).includes('…');
  })()],
  ['パラメータ化した名前は基準の値で出す', (() => {
    const g = E.buildGraph(baseComplex.groups[0].sql, baseComplex.groups[0].params);
    return !/\{\{P/.test(g.nodes.map((n) => n.label).join(' ')) &&
      g.nodes.some((n) => n.params.length > 0);
  })()],
  ['ERD は全グループを縦に積む（切り替え操作が要らない）', (() => {
    const blocks = (pageCases[1].html.match(/class="vg-erdblock"/g) || []).length;
    const svgs = (pageCases[1].html.match(/<svg /g) || []).length;
    return blocks === base3.groupCount && svgs === base3.groupCount;
  })()],
  ['ERD の並びは解析結果の順（基準という考え方を持たない）', (() => {
    const names = [...pageCases[1].html.matchAll(/class="vg-erdname">([^<]*)</g)]
      .map((m) => m[1]);
    return names.join(' | ') === base3.groups.map(Ch.label).join(' | ') &&
      !/vg-erdhead"><span class="vg-tbadge"/.test(pageCases[1].html);
  })()],
  ['ERD にラジオを置かない（外側タブと干渉しない）',
    !/class="vg-r vg-r\d+" type="radio"[^>]*name="vge/.test(pageCases[1].html)],
  ['パネルの中身がタブの並びと合っている（カラム定義 2 / 差分 3 / ERD 4）', (() => {
    const h = pageCases[1].html;
    const at = (n) => h.indexOf(`vg-opanel vg-op${n}`);
    return at(1) < at(2) && at(2) < at(3) && at(3) < at(4) &&
      h.indexOf('vg-ctable') > at(2) && h.indexOf('vg-ctable') < at(3) &&
      h.indexOf('<svg ') > at(4);
  })()],
  ['ERD の CSS が chrome 側にある',
    R.chromeCss().includes('.vg-otab') && R.chromeCss().includes('.vg-erdbox')],
  // メモ（Markdown）。ビューの中から呼ぶので、崩れても落ちないことが要件。
  ['メモは見出し・表・入れ子リスト・コードを出す', (() => {
    const h = memoCases[0].html;
    return h.includes('<h1 class="vg-mdh1">') && h.includes('<table class="vg-mdtable">') &&
      h.includes('<ul class="vg-mdul"><li class="vg-mdli">') &&
      h.includes('<ul class="vg-mdul">', h.indexOf('<li class="vg-mdli">')) &&
      h.includes('<pre class="vg-mdpre">') && h.includes('<ol class="vg-mdol">');
  })()],
  ['メモの表は列ごとの寄せを引き継ぐ',
    memoCases[0].html.includes('vg-mdth vg-mdtc') &&
    memoCases[0].html.includes('vg-mdtd vg-mdtr')],
  ['メモは _ を強調にしない（名前が斜体にならない）',
    memoCases[0].html.includes('snake_case_name') &&
    !memoCases[0].html.includes('<em>case</em>')],
  ['メモのリンクは別タブで開く（レポートは iframe の中）',
    memoCases[0].html.includes('target="_blank" rel="noopener noreferrer"') &&
    memoCases[0].html.includes('rev=2')],
  ['メモは生の HTML を通さない', (() => {
    const h = Md.markdownHtml('<b>x</b> <img src=y onerror=z>\n\n<script>bad()</script>');
    // 素通ししていれば <b> や <img が markup として出る。全部実体参照になる。
    return !/<(b|img|script)\b/i.test(h) &&
      h.includes('&lt;img src=y onerror=z&gt;') && h.includes('&lt;script&gt;');
  })()],
  ['メモの画像はリンクにする（外部から引かない）', (() => {
    const h = Md.markdownHtml('![図](https://example.com/a.png)');
    return !h.includes('<img') && h.includes('>図</a>');
  })()],
  ['メモは javascript: を出さない',
    !/javascript/i.test(Md.markdownHtml('[x](javascript:alert(1))'))],
  ['メモが空なら未登録の枠を返す',
    Md.markdownHtml('').includes('vg-mdempty') &&
    Md.markdownHtml('  \n  ').includes('vg-mdempty')],
  // カラム定義。グループではなく View ごとの属性なので、同じグループの中で
  // 型が割れることがある。それはロジック差分には出てこないので、必ず印を出す。
  ['カラム定義は 1 枚の表で全グループを並べる', (() => {
    const h = columnCases[0].html;
    const heads = [...h.matchAll(/class="vg-chead[^"]*">(?:<span[^>]*>基準<\/span>)?([^<]*)</g)]
      .map((m) => m[1]);
    return h.includes('vg-ctable') &&
      heads[0] === '列名' && heads.length === base3.groupCount + 1 &&
      heads[1] === Ch.label(base3.groups[0]);
  })()],
  ['グループ内で型が割れていたら印を出す（ロジック差分には出ない差）', (() => {
    const h = columnCases[0].html;
    return h.includes('vg-cmix') && h.includes('vg-cwarn') &&
      h.includes('NUMERIC / FLOAT64') &&
      // 内訳が tooltip に出る（suffix・並び順・型・NULL 制約）
      /data-tip="[^"]*abus = #4 FLOAT64 NULL 可/.test(h) &&
      /data-tip="[^"]*abuk = #4 NUMERIC NOT NULL/.test(h) &&
      h.includes('揃っていない箇所が');
  })()],
  ['多数派と違う型・持っていない列が分かる（基準は立てない）', (() => {
    const h = columnCases[0].html;
    return h.includes('currency') && h.includes('vg-cnone') && h.includes('vg-cdiff') &&
      // 表に「基準」の表記もその色分けも無い
      !h.includes('基準') && !h.includes('vg-cref');
  })()],
  ['列の説明を列名の下に出す',
    columnCases[0].html.includes('vg-cdesc') &&
    columnCases[0].html.includes('受注日（JST）')],
  ['カラム定義が取れなければ案内を出す（表は出さない）',
    columnCases[1].html.includes('カラム定義を取得できませんでした') &&
    !columnCases[1].html.includes('vg-ctable')],
  ['カラム定義の CSS は columns.js 側にある',
    Co.columnsCss().includes('.vg-ctable') && !R.chromeCss().includes('.vg-ctable')],
  ['メモの CSS は markdown.js 側にある（差分の UDF に積まない）',
    Md.memoCss().includes('.vg-mdtable') && !R.chromeCss().includes('.vg-mdtable')],
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
    chromeCss() + '\n' + Md.memoCss() + '\n' + Co.columnsCss() +
    '\n</style>\n</head>\n<body>\n' +
    pageCases.concat(parts, memoCases, columnCases)
      .map((p) => `<h2>${p.title}</h2>\n${p.html}`).join('\n') +
    '\n</body>\n</html>\n';
  await mkdir(join(here, 'dist'), { recursive: true });
  const out = join(here, 'dist', 'preview.html');
  await writeFile(out, page);
  console.log(`wrote ${out}`);
}

process.exit(failed === 0 ? 0 : 1);
