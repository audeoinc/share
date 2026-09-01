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
const Sq = require(join(here, 'sqltext.js'));
const V = require(join(here, 'viewdesc.js'));

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

// note タブの上段に出す「View 自身の description」。**Markdown を HTML に
// するのは SQL 側（viewlgc_markdown）**なので、描画側へは変換済みで渡る。
// ここでも同じ順で通して、実物と同じものを見る。
const VIEW_DESC_MD = [
  '## v_daily_sales_abjp',
  '',
  'リージョン別の日次売上。**受注日は JST** で切っている。',
  '',
  '| 項目 | 値 |',
  '|:--|:--|',
  '| 更新 | 03:00 |',
  '| 所有 | データ基盤チーム |',
].join('\n');
const VIEW_DESC_US_MD = [
  '## v_daily_sales_abus',
  '',
  'リージョン別の日次売上。**受注日は UTC** で切っている（jp とここが違う）。',
].join('\n');

/**
 * SQL 側の base_descs と同じ形（[{v: [View 名...], h: HTML}]）を作る。
 * pick(viewName) が返す Markdown ごとに View を畳む。空文字は
 * 「description が設定されていない組」で、SQL 側も空のまま渡す。
 */
const fakeDescs = (b, pick) => {
  const by = new Map();
  for (const g of b.groups) for (const m of g.members) {
    const md = String(pick(m.viewName, g) || '');
    if (!by.has(md)) by.set(md, []);
    by.get(md).push(m.viewName);
  }
  return [...by.entries()].map(([md, v]) =>
    ({ v, h: md ? Md.markdownHtml(md) : '' }));
};

const memoCases = [
  { title: 'メモ（シートに登録あり）', html: Md.markdownHtml(NOTE_MD) },
  { title: 'メモ（未登録）', html: Md.markdownHtml(null) },
];

// note タブ。上段が description、下段がシートのメモ。上段は割れていれば
// タブになり、1 種類ならタブは出ない。どちらも無ければ段そのものを出さない。
const noteCases = [
  { title: 'note（description が割れている = 上段がタブ）',
    html: `<div class="vg-root">` + V.renderNote(base3,
      fakeDescs(base3, (v) => (/jp$/.test(v) ? VIEW_DESC_MD : VIEW_DESC_US_MD)),
      Md.markdownHtml(NOTE_MD)) + `</div>` },
  { title: 'note（description が全 View 同じ = 押せない見出し 1 枚）',
    html: `<div class="vg-root">` + V.renderNote(base3,
      fakeDescs(base3, () => VIEW_DESC_MD), Md.markdownHtml(NOTE_MD)) + `</div>` },
  { title: 'note（description が一部の View にしか無い）',
    html: `<div class="vg-root">` + V.renderNote(base3,
      fakeDescs(base3, (v) => (/jp$/.test(v) ? VIEW_DESC_MD : '')),
      Md.markdownHtml(NOTE_MD)) + `</div>` },
  { title: 'note（description が 1 つも無い = 未設定と書く）',
    html: `<div class="vg-root">` + V.renderNote(base3,
      fakeDescs(base3, () => ''), Md.markdownHtml(NOTE_MD)) + `</div>` },
];

// カラム定義の代わり。実際は INFORMATION_SCHEMA.COLUMNS から作った並びが来る。
//
// 表の列はロジック グループではなくカラム定義で束ね直すので、ここは
// **View ごとに定義が全部違う**いちばん厳しい形にしてある（型が jp は NUMERIC・
// us は FLOAT64、モードが uk だけ REQUIRED、説明がロジック グループごとに別、
// 列の有無もグループごとに別 → 9 本の View が 9 列になる）。列が最大まで
// 増えたときに幅が持つかを目で見るため。まとまる側は mergedColumns で見る。
const fakeColumns = (b) => {
  const out = {};
  for (const g of b.groups) {
    g.members.forEach((m, i) => {
      const suffix = g.suffixes[i] || m.viewName;
      const cols = [
        // description は素のテキストのことも、論理名を持たせた JSON のこともある
        { n: 'order_date', t: 'DATE', o: 1, u: 'NO',
          d: '{"ja":"受注日","en":"order date"}' },
        { n: 'region', t: 'STRING', o: 2, u: 'YES',
          d: '{"name_ja":"リージョン","name_en":"region","unit":"ISO 3166"}' },
        // 長い型。空白が少なく 1 語に近いので、折り返せないと横に伸びる
        { n: 'amount_breakdown', o: 3, u: 'YES', d: '通貨ごとの内訳',
          t: 'ARRAY<STRUCT<currency STRING, gross NUMERIC, net NUMERIC, tax NUMERIC>>' },
        // STRUCT の中身。COLUMN_FIELD_PATHS から来る（並び順も NULL 制約も無い）。
        // わざと宣言順と違う順で渡して、描画側が並べ替えることを見る。
        { n: 'amount_breakdown.tax', t: 'NUMERIC', o: 3, u: null, d: '消費税' },
        { n: 'amount_breakdown.currency', t: 'STRING', o: 3, u: null,
          d: '{"ja":"通貨","en":"currency"}' },
        { n: 'amount_breakdown.gross', t: 'NUMERIC', o: 3, u: null, d: '税込み金額' },
        { n: 'amount_breakdown.net', t: /us$/.test(suffix) ? 'FLOAT64' : 'NUMERIC',
          o: 3, u: null, d: '税抜き金額' },
        // グループ間で型が違う例。同じ列名で片方だけ NUMERIC。
        { n: 'order_count', t: g === b.groups[1] ? 'NUMERIC' : 'INT64', o: 4, u: 'YES', d: '' },
        // グループによって説明が違う例。セルに置いていれば横に並んで見える
        { n: 'gross_amount', t: /us$/.test(suffix) ? 'FLOAT64' : 'NUMERIC', o: 5,
          u: /uk$/.test(suffix) ? 'NO' : 'YES',
          d: g === b.groups[0]
            ? '税抜き。参照先テーブルの型に引きずられる'
            : '税込み（2026-04 に税抜きへ変更予定）' },
      ];
      // 先頭以外のグループには列を 1 本足す／落とす
      if (g !== b.groups[0]) cols.push({ n: 'currency', t: 'STRING', o: cols.length + 1, u: 'YES', d: '通貨コード' });
      if (g === b.groups[b.groups.length - 1]) cols.splice(1, 1);
      out[m.viewName] = cols;
    });
  }
  return out;
};

// 定義がまとまる側。ロジックは 3 グループだが、カラム定義は 2 種類しかない
// （ef 系だけ列が 1 本多い）。ロジック グループを跨いで 1 列にまとまることを見る。
const mergedColumns = (b) => {
  const out = {};
  const last = b.groups[b.groups.length - 1];
  for (const g of b.groups) {
    for (const m of g.members) {
      const cols = [
        { n: 'order_date', t: 'DATE', o: 1, u: 'NO', d: '{"ja":"受注日","en":"order date"}' },
        { n: 'region', t: 'STRING', o: 2, u: 'YES', d: '{"ja":"リージョン"}' },
        { n: 'gross_amount', t: 'NUMERIC', o: 3, u: 'YES', d: '税抜き' },
      ];
      if (g === last) cols.push({ n: 'currency', t: 'STRING', o: 4, u: 'YES', d: '通貨コード' });
      out[m.viewName] = cols;
    }
  }
  return out;
};

// 並び順だけが違う形。列名・型・モード・説明はどれも同じなので 1 列にまとまり、
// 食い違いは ⚠ にだけ出る（並び順は列の束ね方の鍵に入れていない）。
const reorderedColumns = (b) => {
  const out = {};
  for (const g of b.groups) {
    g.members.forEach((m, i) => {
      const swap = /us$/.test(g.suffixes[i] || m.viewName);
      out[m.viewName] = [
        { n: 'order_date', t: 'DATE', o: 1, u: 'NO', d: '受注日' },
        { n: 'region', t: 'STRING', o: swap ? 3 : 2, u: 'YES', d: 'リージョン' },
        { n: 'gross_amount', t: 'NUMERIC', o: swap ? 2 : 3, u: 'YES', d: '税抜き' },
      ];
    });
  }
  return out;
};

// SQL タブに渡す素のテキスト。実際は INFORMATION_SCHEMA.VIEWS の
// view_definition が SQL 経由で来る。ここでは解析前の ddl をそのまま使う
// （preview の base は analyze() の生の結果なので members に残っている）。
const fakeSql = (b) => {
  const out = {};
  for (const g of b.groups) for (const m of g.members) out[m.viewName] = m.ddl;
  return out;
};

// 実際に Looker へ渡すのは、差分と参照関係を外側タブで束ねた 1 枚。
// プレビューの先頭にその形も置いて、束ねた状態で崩れないかを見る。
// メモは作り置きせず、ビューが REPLACE で差し込む（シートを直した内容を
// その場で出すため）。ここでも同じ置換をして、実物と同じ形を見る。
const splice = (html, note) => html.replace(Ch.NOTE_MARK, note);

const pageCases = [
  { title: '外側タブ（note / カラム定義 / 参照関係 / ロジック差分 / SQL）',
    b: baseComplex, opts: {}, note: NOTE_MD,
    pick: (v) => (/jp$/.test(v) ? VIEW_DESC_MD : VIEW_DESC_US_MD) },
  { title: '外側タブ・3 グループ', b: base3, opts: {}, note: NOTE_MD,
    pick: () => VIEW_DESC_MD },
  { title: '外側タブ・メモも description も未登録の base',
    b: base2, opts: {}, note: null, pick: () => '' },
].map((c) => ({ ...c,
  html: splice(
    Ch.wrapPage(R.renderBase(c.b, c.opts), E.renderErdBase(c.b),
      Co.renderColumnsBase(c.b, fakeColumns(c.b)), Sq.renderSqlBase(c.b, fakeSql(c.b)),
      V.renderNote(c.b, fakeDescs(c.b, c.pick), Ch.NOTE_MARK),
      c.b),
    Md.markdownHtml(c.note)) }));

// 列はロジック グループではなくカラム定義で束ね直すので、ロジック差分の
// タブとは本数が合わない。分かれる／まとまる／並び順だけ違う を並べて見る。
const columnCases = [
  { title: 'カラム定義（View ごとに定義が違う = 列が最大まで増える）',
    html: Co.renderColumnsBase(base3, fakeColumns(base3)) },
  { title: 'カラム定義（ロジックは 3 グループ・定義は 2 種類）',
    html: Co.renderColumnsBase(base3, mergedColumns(base3)) },
  { title: 'カラム定義（並び順だけが違う = 1 列にまとめて ⚠）',
    html: Co.renderColumnsBase(base3, reorderedColumns(base3)) },
  { title: 'カラム定義（取得できなかった場合）',
    html: Co.renderColumnsBase(base3, {}) },
];

/** その HTML に出ている定義グループの本数（= 列名を除いた見出しの数）。 */
const defGroups = (html) => (html.match(/<th class="vg-chead">/g) || []).length;

const sqlCases = [
  { title: 'SQL（View ごと・インナー タブは suffix）',
    html: Sq.renderSqlBase(base3, fakeSql(base3)) },
  { title: 'SQL（取得できなかった場合）',
    html: Sq.renderSqlBase(base3, {}) },
];

// カラム定義の表から、見出しが name の行を引く。見出しはタグを挟む
// （<span class="vg-cnestmark">└</span>currency）ので、素の substring では拾えない。
//
// 区切りは '<tr>' ではなく行の先頭ごと。セルの中にも表（description の
// key / value）が入っていて、そちらの <tr> でも切れてしまうため。
const columnRow = (name, html) => (html || columnCases[0].html)
  .split('<tr><th class="vg-cname')
  .map((r) => '<th class="vg-cname' + r)
  .find((r) => {
    const th = r.match(/<th class="vg-cname[^"]*">([\s\S]*?)<\/th>/);
    return th && th[1].replace(/<[^>]*>/g, '') === name;
  });

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
  // 打ち切りが通常の運用で当たると「基準を選べない」という、故障と見分けの
  // 付かない形で表に出る。歯止めは 1 行が BigQuery の上限を超えるのを防ぐ
  // ためのものなので、実データより十分大きいところまで当たらないこと。
  // 長い SQL（500 行）× 6 グループ = 15 MB でもそろう。実測は基準 1 つぶんの
  // 最大が 690 KB なので、ここまで来ることはない。
  ['実データより大きい入力でも基準タブが全部そろう', (() => {
    const long = (suf, extra) =>
      'SELECT\n' + Array.from({ length: 500 },
        (_, i) => `  col_${i} + ${extra} AS c_${i},`).join('\n') +
      `\n  1 AS tail\nFROM t_${suf}`;
    const parts = [['ab', 1], ['cd', 2], ['ef', 3], ['gh', 4], ['ij', 5], ['kl', 6]];
    const rows = [];
    for (const [p, extra] of parts) {
      for (const r of ['jp', 'us']) rows.push({ view_name: `v_l_${p}${r}`, ddl: long(p + r, extra) });
    }
    const b = A.analyze(rows, { suffixParts: [parts.map((p) => p[0]), ['jp', 'us']],
      substitutable: ['entity'] }).bases[0];
    const h = R.renderBase(b, {});
    return b.groups.length === 6 &&
      (h.match(/class="vg-btab /g) || []).length === 6 &&
      !h.includes('基準にできるのは先頭') &&
      // 15 MB 前後。BigQuery の 1 行 100 MB には遠い
      Buffer.byteLength(h) > 10 * 1024 * 1024;
  })()],
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
  ['外側タブが 5 枚出る（note / カラム定義 / 参照関係 / ロジック差分 / SQL）',
    (pageCases[0].html.match(/class="vg-otab /g) || []).length === Ch.OUTER_TABS.length &&
    Ch.OUTER_TABS.join(',') === 'note,カラム定義,参照関係,ロジック差分,SQL'],
  ['既定で開くのはいちばん左のメモ タブ', (() => {
    const h = pageCases[0].html;
    // checked が付くのは 1 枚目だけ。外側タブの CSS も 1 枚目を開く形になる。
    return /class="vg-or vg-or1" type="radio" name="[^"]*" id="[^"]*-1" checked>/.test(h) &&
      !/vg-or(2|3)" type="radio"[^>]*checked/.test(h) &&
      R.chromeCss().includes('.vg-or1:checked ~ .vg-opanels > .vg-op1{display:block}');
  })()],
  ['メモは作り置きせずビューが差し込む（目印が残っている）', (() => {
    const raw = Ch.wrapPage('<i>D</i>', '<i>E</i>', 'x', 'y');
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
    /\.vg-outer\{max-height:min\(100vh,\d+px\);overflow:auto;--vg-bar:\d+px\}/
      .test(R.chromeCss())],
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
  // ズレは「CSS が古い」方向にも起きる。カードは日次で作り直され、CSS は手で
  // 貼るので、タブを足すと必ず「カードは新しい・CSS は古い」時間帯ができる。
  // いま並べる枚数ぶんしか規則が無いと、足したタブは押せるのに中身が出ない。
  // 先の番号まで出しておけば、次はカードの貼り替えだけで動く。
  ['外側タブの CSS を並べる枚数より多く用意してある（CSS が古くても次は動く）', (() => {
    const css = R.chromeCss();
    const n = Ch.OUTER_TABS.length;
    return Ch.MAX_OUTER_TABS > n &&
      [...Array(Ch.MAX_OUTER_TABS).keys()].every((i) =>
        css.includes(`.vg-or${i + 1}:checked ~ .vg-opanels > .vg-op${i + 1}{display:block}`) &&
        CARD_GENERATIONS.every(([path]) =>
          css.includes(`.vg-or${i + 1}:checked ~ ${path}.vg-ot${i + 1}`))) &&
      !css.includes(`.vg-or${Ch.MAX_OUTER_TABS + 1}:checked`);
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
  // 注記は辺の中点に置き、行数ぶん上下に広がる。結合キーが多いと箱の並びの
  // 外へはみ出すので、図の高さはそれも含めて決める。
  ['結合キーが多い注記が図からはみ出さない', (() => {
    const sql = 'SELECT 1 FROM a LEFT JOIN b ON a.k1=b.k1 AND a.k2=b.k2 AND a.k3=b.k3' +
      ' AND a.k4=b.k4 AND a.k5=b.k5 AND a.k6=b.k6';
    const lay = E.layout(E.buildGraph(sql, []));
    const svg = E.toSvg(lay);
    const ys = [...svg.matchAll(/<tspan x="[^"]*" y="([-0-9.]+)"/g)].map((m) => Number(m[1]));
    const top = lay.y0 || 0;
    // 注記の 1 行目の上端（y から 11px 上）と最終行の下端が viewBox に入る
    return ys.length === 7 &&
      Math.min(...ys) - 11 >= top &&
      Math.max(...ys) + 3 <= top + lay.height &&
      // 箱だけで決めていた頃の高さでは入りきらない形であること
      lay.height > 10 * 2 + E.BOX_H + 6;
  })()],
  ['ERD にラジオを置かない（外側タブと干渉しない）',
    !/class="vg-r vg-r\d+" type="radio"[^>]*name="vge/.test(pageCases[1].html)],
  ['パネルの中身がタブの並びと合っている（カラム定義 2 / ERD 3 / 差分 4 / SQL 5）', (() => {
    const h = pageCases[1].html;
    const at = (n) => h.indexOf(`vg-opanel vg-op${n}`);
    return at(1) < at(2) && at(2) < at(3) && at(3) < at(4) && at(4) < at(5) &&
      h.indexOf('vg-ctable') > at(2) && h.indexOf('vg-ctable') < at(3) &&
      h.indexOf('<svg ') > at(3) && h.indexOf('<svg ') < at(4) &&
      h.indexOf('vg-btablist') > at(4) && h.indexOf('vg-btablist') < at(5) &&
      h.indexOf('vg-stablist') > at(5);
  })()],
  // CSS は手で貼り、カードは日次で作り直す。順序はいつも「カードが先・CSS が
  // 後」なので、その間カードは新しい markup ＋ 古い CSS で表示される。
  // クラスの頭ごと増える機能は吸収できないので、せめて原因が画面から読める
  // ようにする。カードに世代の印を埋め、その世代の CSS だけがそれを消す。
  ['カードに CSS の世代の印がある（古い CSS では案内が出る）', (() => {
    const h = pageCases[0].html;
    const mark = `class="vg-cssgen${Ch.CSS_GEN}"`;
    return h.split(mark).length - 1 === 1 &&
      // CSS が 1 行も効いていない場面で出るので、飾りは style 属性に直書き
      /class="vg-cssgen\d+" style="[^"]*background:#FFF8C5/.test(h) &&
      // いちばん上（どのタブを開いていても見える）
      h.indexOf(mark) < h.indexOf('vg-otablist') &&
      // 印を消せるのはいまの世代の規則だけ
      R.chromeCss().includes(`.vg-cssgen${Ch.CSS_GEN}{display:none}`) &&
      !R.chromeCss().includes(`.vg-cssgen${Ch.CSS_GEN - 1}{`);
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
  ['メモが空なら未登録の枠を返す（note の下段だけの話）',
    memoCases[1].html.includes('vg-mdempty')],
  // note タブは二段構え。上段が View 自身の description、下段がシートのメモ。
  // 1 本のテキストに繋いでいた頃は、水平線 1 本しか手掛かりが無く、
  // どこまでが公式の説明でどこからが運用メモなのかが読み取れなかった。
  ['note は description の段とメモの段に分かれる', (() => {
    const h = noteCases[0].html;
    return h.includes('<div class="vg-nhead">View の description</div>') &&
      h.includes('<div class="vg-nhead">メモ</div>') &&
      h.indexOf('View の description') < h.indexOf('vg-nhead">メモ') &&
      h.includes('データ基盤チーム') && h.includes('v_daily_sales について');
  })()],
  ['description が割れていたら上段がタブになる（見出しは suffix）', (() => {
    const h = noteCases[0].html;
    const tabs = [...h.matchAll(/class="vg-dtab vg-dt\d+"[^>]*>([^<]*)</g)].map((m) => m[1]);
    // jp とそれ以外の 2 文面。多いほうが先（既定で開くタブ）
    return tabs.length === 2 &&
      tabs[0] === 'abus, abuk, cdus, cduk, efus, efuk'.split(', ').sort().join(', ') &&
      tabs[1] === 'abjp, cdjp, efjp' &&
      (h.match(/class="vg-dpanel /g) || []).length === 2;
  })()],
  // 1 種類でも見出しは出す。あれは飾りではなく caption で、「どの View の
  // description か」は description そのものと同じくらい大事な情報。隠すと
  // 全 View に付いているのか 1 本だけなのかが読めない。ただしラジオは
  // 持たせない（押せそうに見えて何も起きない状態を作らない）。
  ['description が 1 種類でも suffix を羅列した見出しを出す', (() => {
    const h = noteCases[1].html;
    const m = h.match(/<span class="vg-dtab vg-dstatic">([^<]*)<span class="vg-tabn">(\d+)</);
    return m !== null && h.includes('受注日は JST') &&
      // base の全 View ぶんが並ぶ
      m[1] === base3.groups.flatMap((g) => g.suffixes).sort().join(', ') &&
      Number(m[2]) === base3.viewCount &&
      // ラジオも <label> も出さない（切り替える先が無いので）
      !h.includes('vg-dr') && !h.includes('<label class="vg-dtab');
  })()],
  ['選択中と押せない見出しは同じ塗り（どちらも「いま見ているもの」）', (() => {
    const css = V.descCss();
    const on = 'background:#EAEEF2;border-color:#8C959F;color:#24292F';
    return css.includes(`.vg-dtab.vg-dstatic{${on};cursor:default}`) &&
      css.includes(`.vg-dr1:checked ~ .vg-dtablist > .vg-dt1{${on}}`) &&
      // 緑は使わない。このカードでは緑に別の意味がある（差分の追加・
      // 「1 グループ = 全部同じ」バッジ）ので、選択状態と読み分けられなくなる
      !/\.vg-d[a-z]*[0-9]*[^}]*#DAFBE1/.test(css) &&
      // hover は選択中より 1 段薄い。同じ色だと選択とマウス位置が区別できない
      css.includes('.vg-dtab:hover{background:#F6F8FA;color:#24292F}') &&
      // 押せない見出しは hover のあとに置いて勝たせる（乗っても光らない）
      css.indexOf('.vg-dtab.vg-dstatic{') > css.indexOf('.vg-dtab:hover{');
  })()],
  ['description が一部にしか無ければ、その組も出す（黙って消さない）', (() => {
    const h = noteCases[2].html;
    const tabs = [...h.matchAll(/class="vg-dtab vg-dt\d+"[^>]*>([^<]*)</g)].map((m) => m[1]);
    // 中身のある組が先、未設定の組は最後
    return tabs.length === 2 && tabs[0] === 'abjp, cdjp, efjp' &&
      h.includes('description が設定されていません');
  })()],
  // 1 つも設定されていなくても段は出す。消すと、未設定なのか取り込みに
  // 失敗しているのか画面から読めず、ただ何も出ない状態になる。
  ['description が 1 つも無くても段を出して「未設定」と書く', (() => {
    const h = noteCases[3].html;
    const m = h.match(/<span class="vg-dtab vg-dstatic">([^<]*)<span class="vg-tabn">(\d+)</);
    return h.includes('vg-nhead">View の description') &&
      h.includes('description が設定されていません') &&
      // どの View のことかは見出しに出る（範囲が分かる）
      m !== null && Number(m[2]) === base3.viewCount &&
      m[1] === base3.groups.flatMap((g) => g.suffixes).sort().join(', ') &&
      // メモの段はそのまま出る
      h.includes('vg-nhead">メモ') && h.includes('v_daily_sales について');
  })()],
  ['組がひとつも作れなければ「取得できなかった」と書く（未設定と区別）', (() => {
    const h = V.renderNote(base3, [], '(メモ)');
    return h.includes('description を取得できませんでした') &&
      !h.includes('設定されていません') && h.includes('(メモ)');
  })()],
  ['note タブのラジオは外側・基準・比較・SQL と別のクラス（連動しない）', (() => {
    const css = V.descCss();
    return /\.vg-dr1:checked ~ \.vg-dpanels > \.vg-dp1\{display:block\}/.test(css) &&
      !/\.vg-or\d|\.vg-br\d|\.vg-sr\d/.test(css) &&
      !/[^d]\.vg-r\d/.test(css);
  })()],
  ['note タブの CSS が上限枚数ぶんある', (() => {
    const css = V.descCss();
    const n = [...css.matchAll(/\.vg-dr(\d+):checked ~ \.vg-dpanels/g)]
      .map((m) => Number(m[1]));
    return n.length === Ch.MAX_DESC_TABS &&
      Math.max(...n) === Ch.MAX_DESC_TABS;
  })()],
  ['note の CSS は viewdesc.js 側にある',
    V.descCss().includes('.vg-nhead') && !R.chromeCss().includes('.vg-nhead')],
  // カラム定義の列はロジック グループではなく**カラム定義**で束ねる。
  // SQL が同一でも参照先の型や description が違えば別の列になり、逆に別ロジック
  // でも定義が同じなら 1 列にまとまる。ロジック差分には出てこない差がここに出る。
  ['カラム定義は 1 枚の表で全グループを並べる', (() => {
    const h = columnCases[0].html;
    const heads = [...h.matchAll(/class="vg-chead[^"]*">(?:<span[^>]*>基準<\/span>)?([^<]*)</g)]
      .map((m) => m[1]);
    return h.includes('vg-ctable') &&
      heads[0] === '列名' && heads.length === defGroups(h) + 1 &&
      // いちばん多い定義が先頭（同数なら suffix 順）。fixture は全部 1 本ずつ
      heads[1] === 'abjp';
  })()],
  ['列はロジック グループではなくカラム定義で束ねる', (() => {
    // fixture は View ごとに定義が違うので、ロジックは 3 グループでも列は 9 本
    const h0 = columnCases[0].html;
    // 定義が 2 種類しか無ければ、ロジックが 3 グループでも列は 2 本
    const h1 = columnCases[1].html;
    const heads1 = [...h1.matchAll(/<th class="vg-chead">([^<]*)</g)].map((m) => m[1]);
    return defGroups(h0) === base3.viewCount && base3.groupCount === 3 &&
      defGroups(h1) === 2 &&
      // ロジック グループを跨いで 1 列にまとまる（ab と cd が同じ列）
      heads1[0] === 'abjp, abuk, abus, cdjp, cduk, cdus' &&
      heads1[1] === 'efjp, efuk, efus' &&
      h1.includes('カラム定義が 2 種類あります');
  })()],
  ['定義が全 View で同じなら列は 1 本（そう言い切る）', (() => {
    const one = {};
    for (const g of base3.groups) for (const m of g.members) {
      one[m.viewName] = [{ n: 'a', t: 'INT64', o: 1, u: 'YES', d: '' }];
    }
    const h = Co.renderColumns(base3, one);
    return defGroups(h) === 1 &&
      h.includes(`${base3.viewCount} 本の View すべてでカラム定義`) &&
      !h.includes('vg-cdiff') && !h.includes('vg-cmix');
  })()],
  ['並び順だけの違いでは列を分けない（1 列にまとめて ⚠）', (() => {
    const h = columnCases[2].html;
    return defGroups(h) === 1 && h.includes('vg-cmix') && h.includes('vg-cwarn') &&
      // 内訳が tooltip に出る（suffix・並び順・型・NULL 制約）
      /data-tip="[^"]*abus = #3 STRING NULLABLE/.test(h) &&
      /data-tip="[^"]*abjp = #2 STRING NULLABLE/.test(h) &&
      h.includes('並び順（ordinal）だけが食い違っている');
  })()],
  ['説明だけが違っても色で分かる（列は増えるのに色が無い、を作らない）', (() => {
    const byView = {};
    for (const g of base3.groups) for (const m of g.members) {
      byView[m.viewName] = [{ n: 'a', t: 'INT64', o: 1, u: 'YES',
        d: /jp$/.test(m.viewName) ? '受注日' : '受注日（旧）' }];
    }
    const h = Co.renderColumns(base3, byView);
    return defGroups(h) === 2 && h.includes('vg-cdiff') &&
      h.includes('型・モード・説明のいずれかが揃っていない列が 1 件');
  })()],
  ['多数派と違う型・持っていない列が分かる（基準は立てない）', (() => {
    const h = columnCases[0].html;
    return h.includes('currency') && h.includes('vg-cnone') && h.includes('vg-cdiff') &&
      // 表に「基準」の表記もその色分けも無い
      !h.includes('基準') && !h.includes('vg-cref');
  })()],
  // 列名の行はスクロールしても残す。貼り付く位置は帯の高さ（--vg-bar）で
  // 決めているので、帯の中身を変えたらここもズレる。実際にブラウザで測るのは
  // preview では無理なので、CSS の数値と帯を構成する寸法の対応を書き留めて
  // 突き合わせる（実測は開発時に dist/preview.html を開いて確認する）。
  ['列名の行を帯の下に貼り付ける', (() => {
    const css = R.chromeCss() + '\n' + Co.columnsCss();
    const bar = Number((css.match(/--vg-bar:(\d+)px/) || [])[1]);
    // 帯 = 上下の padding 8+8 ＋ 見出し行 ＋ 行間 6 ＋ タブ。実測 75px。
    return bar === 75 &&
      /\.vg-chead\{position:sticky;top:var\(--vg-bar\)/.test(css);
  })()],
  // 型は空白が少なく、ブラウザから見ると 1 語に近い。CSS の折り返しが埋め込み
  // 先で効かなくても折れるよう、markup 側にも <wbr> を入れる。
  ['長い型に折り返し位置を入れる（CSS が効かなくても折れる）', (() => {
    const t = Co.breakType(Ch.esc('ARRAY<STRUCT<currency STRING, gross NUMERIC>>'));
    // 子の行があれば親は RECORD に畳むので、表に長い型が出るのは
    // 畳まないとき（include_nested_fields = FALSE など）。そちらで見る。
    const g = { suffixes: ['abjp'], members: [{ viewName: 'v_x_abjp' }] };
    const h = Co.renderColumns({ groups: [g] }, { v_x_abjp: [
      { n: 'a', t: 'ARRAY<STRUCT<currency STRING, gross NUMERIC>>', o: 1, u: 'YES', d: '' }] });
    return t.includes('ARRAY&lt;<wbr>STRUCT&lt;<wbr>') &&
      t.includes('STRING,<wbr>') &&
      // エスケープした山括弧を壊していない
      !t.includes('<STRUCT') &&
      h.includes('<wbr>');
  })()],
  ['セルの折り返しは CSS でも指定する（二重の備え）',
    /\.vg-ccell\{[^}]*overflow-wrap:anywhere;word-break:break-all/.test(Co.columnsCss())],
  ['カラム定義の表に最大幅がある（広いチャートで間延びさせない）',
    /\.vg-ctable\{[^}]*max-width:1000px/.test(Co.columnsCss())],
  // 列名の欄は px、グループの列は幅を指定せず残りを均等に分ける
  // （table-layout:fixed の決まり）。割合にすると、列が増えて表を広げたときに
  // 列名の欄まで一緒に広がり、名前しか入っていない欄に幅を取られる。
  ['カラム定義の幅は列名だけ px・残りは均等割り', (() => {
    const h = columnCases[1].html;
    const css = Co.columnsCss();
    const cols = h.slice(h.indexOf('<colgroup'), h.indexOf('</colgroup>'));
    return cols === `<colgroup><col style="width:180px">` +
        '<col>'.repeat(defGroups(h)) &&
      css.includes('table-layout:fixed') &&
      // 包む側に overflow は置かない。置くとそこが新しいスクロール箱になり、
      // 列名行の sticky（.vg-outer 基準）が効かなくなる。
      !css.includes('overflow-x:auto') &&
      !/\.vg-ccell\{[^}]*white-space:nowrap/.test(css);
  })()],
  // 列はカラム定義ごとなので、最悪 View の本数まで増える。均等割りのままだと
  // 1 列が数十 px になって型も説明も読めない。下限を割るときだけ min-width を
  // 置いて、はみ出したぶんは .vg-outer に横へ流してもらう。
  ['列が増えたら表に min-width を置く（1 列あたりの下限を守る）', (() => {
    const wide = columnCases[0].html;    // 9 列
    const narrow = columnCases[1].html;  // 2 列
    const css = Co.columnsCss();
    const max = Number((css.match(/\.vg-ctable\{[^}]*max-width:(\d+)px/) || [])[1]);
    const min = Number((wide.match(/<table class="vg-ctable" style="min-width:(\d+)px"/) || [])[1]);
    return max === 1000 &&
      // 9 列: 列名 180px + 150px × 9 = 1530px
      min === 1530 && min > max &&
      // 2 列なら下限を割らないので置かない（狭いカードでは縮んでよい）
      !narrow.includes('min-width');
  })()],
  // 表がカードより広くなったら横にもスクロールする。そのとき列名が流れていくと
  // どの行を見ているのか分からなくなるので、列名の欄も貼り付ける。
  // 実測は dist/preview.html を Chromium で開いて確認した（scrollLeft=300 でも
  // 列名の欄は左端 0 のまま、上下は --vg-bar の位置で止まる）。
  ['列名の欄を左に貼り付ける（横スクロールでも行が分かる）', (() => {
    const css = Co.columnsCss();
    const rule = (cls) => css.split('\n').find((r) => r.indexOf('.' + cls + '{') === 0) || '';
    return /position:sticky;left:0/.test(rule('vg-cname')) &&
      // border-collapse:collapse では貼り付いたセルの border が一緒に流れる。
      // 右の境目は box-shadow で自前に描く
      /box-shadow:1px 0 0/.test(rule('vg-cname')) &&
      // 透けると下を通る本文が重なる
      /background:#fff/.test(rule('vg-cname')) &&
      // 左上の角は縦にも横にも貼り付くので、どちらのセルより手前
      /left:0;z-index:2/.test(rule('vg-cnamehead')) &&
      /\.vg-chead\{[^}]*z-index:1/.test(css);
  })()],
  // 説明は View に付いた属性なので、グループによって違うことがある。
  // 列名の欄にまとめると差が消えるので、グループごとのセルに置く。
  // STRUCT の中身は COLUMN_FIELD_PATHS にある。型が ARRAY<STRUCT<...>> の
  // ままだと中の定義が読めないので、行として展開する（グループ間の比較が効く）。
  ['STRUCT の中身を行として出す（親のすぐ下に字下げして）', (() => {
    const h = columnCases[0].html;
    const names = [...h.matchAll(/<th class="vg-cname[^"]*">([\s\S]*?)<\/th>/g)]
      .map((m) => m[1].replace(/<[^>]*>/g, ''));
    const at = names.indexOf('amount_breakdown');
    return at >= 0 &&
      // 親のすぐ下に、宣言順（currency, gross, net, tax）で並ぶ。
      // fixture はわざと違う順で渡している
      names.slice(at + 1, at + 5).join(',') === '\u2514currency,\u2514gross,\u2514net,\u2514tax' &&
      h.includes('class="vg-cname vg-cd1"');
  })()],
  ['ネストの並びは親の型の宣言順（COLUMN_FIELD_PATHS に ordinal が無いため）', (() => {
    return Co.structFields('ARRAY<STRUCT<currency STRING, gross NUMERIC, tax NUMERIC>>')
        .join(',') === 'currency,gross,tax' &&
      Co.structFields('STRUCT<a ARRAY<STRUCT<b INT64, c STRING>>, d INT64>')
        .join(',') === 'a,d' &&
      // 型から読めなければ空。呼び出し側が後ろへ回す
      Co.structFields('STRING').length === 0;
  })()],
  // 中身が子の行に出ているなら、親の型は Console と同じ RECORD / REPEATED に
  // 畳む。同じ内容を 2 か所に出しても場所を取るだけ。
  // 並び順（ordinal）は表に出さない。行がその順に並んでいるので番号を
  // 添えても読めるものが増えず、列を 1 本足すと以降がまとめてずれる。
  ['表に並び順（#N）を出さない', (() => {
    const h = columnCases[0].html;
    const cells = [...h.matchAll(/<span class="vg-cmeta">([^<]*)<\/span>/g)].map((m) => m[1]);
    return cells.length > 0 && cells.every((c) => c.indexOf('#') < 0) &&
      // モードは出る
      cells.some((c) => c === 'REPEATED') &&
      cells.some((c) => c === 'NULLABLE' || c === 'REQUIRED') &&
      // 並び順が食い違ったときの ⚠ の内訳にだけ番号が残る
      /data-tip="[^"]*#3 /.test(columnCases[2].html);
  })()],
  ['STRUCT の親は RECORD / REPEATED に畳む', (() => {
    const parent = columnRow('amount_breakdown');
    return parent && parent.includes('RECORD') && parent.includes('REPEATED') &&
      // 畳んだので中身は親の行に出ない（子の行にある）
      !parent.includes('currency STRING') && !parent.includes('STRUCT');
  })()],
  ['繰り返しスカラーも畳む（中身が無いので情報は落ちない）', (() => {
    const g = { suffixes: ['abjp'], members: [{ viewName: 'v_x_abjp' }] };
    const h = Co.renderColumns({ groups: [g] }, { v_x_abjp: [
      { n: 'tags', t: 'ARRAY<STRING>', o: 1, u: 'YES', d: '' }] });
    return h.includes('STRING') && h.includes('REPEATED') && !h.includes('ARRAY');
  })()],
  ['型の畳み方', (() => {
    const t = (x) => Co.typeShape(x);
    return t('ARRAY<STRUCT<a STRING>>').name === 'RECORD' &&
      t('ARRAY<STRUCT<a STRING>>').repeated === true &&
      t('STRUCT<a STRING>').name === 'RECORD' &&
      t('STRUCT<a STRING>').repeated === false &&
      t('ARRAY<INT64>').name === 'INT64' && t('ARRAY<INT64>').repeated === true &&
      t('INT64').name === 'INT64' && t('INT64').repeated === false;
  })()],
  ['子の行が無ければ畳まない（定義がどこからも読めなくなるため）', (() => {
    const g = { suffixes: ['abjp'], members: [{ viewName: 'v_x_abjp' }] };
    const b = { groups: [g] };
    // include_nested_fields = FALSE の状態を作る（最上位だけ渡す）
    const h = Co.renderColumns(b, { v_x_abjp: [
      { n: 'a', t: 'ARRAY<STRUCT<x INT64, y STRING>>', o: 1, u: 'YES', d: '' }] });
    return h.includes('STRUCT') && h.includes('x INT64') && !h.includes('RECORD');
  })()],
  ['ネストの行には並び順と NULL 制約を出さない（親のものを出さない）', (() => {
    // 行の見出しはタグを挟む（<span>└</span>currency）ので、素の substring では
    // 拾えない。タグを落としてから引く。
    const parent = columnRow('amount_breakdown');
    const child = columnRow('\u2514currency');
    return parent && parent.includes('vg-cmeta') &&
      // 親はモードだけ（並び順は出さない）。子には NULL 制約も出ない
      parent.includes('vg-cmeta">REPEATED<') && !parent.includes('#') &&
      child && !child.includes('vg-cmeta') && child.includes('通貨');
  })()],
  ['ネストでもグループ間の型の違いが色で出る', (() => {
    const net = columnRow('\u2514net');
    // us 系だけ FLOAT64。ネストの型も列の束ね方の鍵に入っているので、
    // us は別の列になり、多数派（NUMERIC）と違うセルに色が付く。
    return net && net.includes('FLOAT64') && net.includes('vg-cdiff');
  })()],
  ['列の説明はグループごとのセルに出す（列名の欄ではない）', (() => {
    const h = columnCases[0].html;
    // 列名の欄には名前だけ
    const names = [...h.matchAll(/<th class="vg-cname">([\s\S]*?)<\/th>/g)].map((m) => m[1]);
    if (!names.length || names.some((n) => n.includes('vg-cdesc'))) return false;
    // セルの中に入っていること
    const cells = [...h.matchAll(/<td class="vg-ccell[^"]*">([\s\S]*?)<\/td>/g)]
      .map((m) => m[1]);
    return cells.some((c) => c.includes('vg-cdesc') && c.includes('税抜き')) &&
      // グループごとに違う説明が、それぞれのセルに出る
      cells.some((c) => c.includes('税込み（2026-04 に税抜きへ変更予定）'));
  })()],
  ['グループの中で説明が割れたら View 名を添えて全部出す', (() => {
    const g = { suffixes: ['abjp', 'abus'],
      members: [{ viewName: 'v_x_abjp' }, { viewName: 'v_x_abus' }] };
    const byView = {
      v_x_abjp: [{ n: 'a', t: 'INT64', o: 1, u: 'YES', d: '受注日' }],
      v_x_abus: [{ n: 'a', t: 'INT64', o: 1, u: 'YES', d: '受注日（旧）' }],
    };
    const one = { v_x_abjp: byView.v_x_abjp, v_x_abus: byView.v_x_abjp };
    const split = Co.descCell(Co.groupColumns(g, byView).get('a'));
    const same = Co.descCell(Co.groupColumns(g, one).get('a'));
    return split.includes('<div class="vg-cdescwho">abjp</div>') &&
      split.includes('<div class="vg-cdescwho">abus</div>') &&
      split.includes('受注日（旧）') &&
      // 1 種類なら見出しは付けない
      !same.includes('vg-cdescwho') && same.includes('受注日');
  })()],
  // description は自由文字列なので、論理名を持たせたければ JSON を入れるしかない。
  // キー名は環境で違うので広めに受け、拾えなかったキーも捨てずに出す。
  // JSON だったものは 2 列の表にする。'key: value' の 1 行だと、どこまでが
  // キーでどこからが値なのかが読み取りにくい（値に ':' が入ることもある）。
  ['description の JSON は 2 列の表にする', (() => {
    const h = columnCases[0].html;
    return h.includes('<table class="vg-cdtable">') &&
      h.includes('<th class="vg-cdk">ja</th><td class="vg-cdv">受注日</td>') &&
      h.includes('<th class="vg-cdk">en</th><td class="vg-cdv">order date</td>') &&
      // 素のテキストはキーが無いので 1 行のまま（従来どおり）
      h.includes('<div class="vg-cdesc">税抜き。参照先テーブルの型に引きずられる</div>') &&
      !h.includes('vg-cdescsub');
  })()],
  ['キーは JSON に書いてあった綴りのまま出す（並び順だけそろえる）', (() => {
    const h = Co.descHtml(JSON.stringify(
      { unit: 'ISO 3166', name_en: 'region', name_ja: 'リージョン' }));
    const keys = [...h.matchAll(/<th class="vg-cdk">([^<]*)<\/th>/g)].map((m) => m[1]);
    // 日本語 -> 英語 -> 残り。綴りは言い換えない
    return keys.join(',') === 'name_ja,name_en,unit';
  })()],
  // 列幅は決め打ちにしない。キー列はいちばん長いキーの幅で止まる。
  // overflow-wrap:anywhere は「最小幅」の計算まで変えるので、値の width:100% と
  // 組み合わせるとキー列が 1 文字まで潰れる（実際にそれで一度出した）。
  // break-word は最小幅を変えないので、キー 1 語ぶんの幅は残る。
  ['説明の表の列幅はキーの実寸に任せる（決め打ちしない）', (() => {
    const h = Co.descHtml(JSON.stringify({ ja: '受注日' }));
    const css = Co.columnsCss();
    return !h.includes('<colgroup') &&
      !/\.vg-cdtable\{[^}]*table-layout:fixed/.test(css) &&
      // 値が残りを取る = キー列はいちばん長いキーの幅で止まる
      /\.vg-cdv\{[^}]*width:100%/.test(css) &&
      // キーは折り返さない。折り返しを許すと最小幅が 1 文字まで詰められる
      /\.vg-cdk\{[^}]*white-space:nowrap/.test(css) &&
      !/\.vg-cdk\{[^}]*overflow-wrap/.test(css);
  })()],
  ['説明のキーは太字にしない（グループ見出しと同じ太さにならない）', (() => {
    const css = Co.columnsCss();
    const rule = css.split('\n').find((r) => r.indexOf('.vg-cdk{') === 0) || '';
    return !/font-weight:600/.test(rule) &&
      // グループ見出しは太字のまま
      /\.vg-chead\{[^}]*font-weight:600/.test(css);
  })()],
  ['モードは型の右に置く（行の高さを節約する）', (() => {
    const h = columnCases[0].html;
    const css = Co.columnsCss();
    return h.includes('<span class="vg-cmeta">') &&
      !h.includes('<div class="vg-cmeta">') &&
      /\.vg-cmeta\{margin-left:/.test(css);
  })()],
  ['値に : が入っていてもキーと混ざらない', (() => {
    const h = Co.descHtml(JSON.stringify({ ja: '受注日', note: '10:00 に確定' }));
    return h.includes('<th class="vg-cdk">note</th><td class="vg-cdv">10:00 に確定</td>');
  })()],
  ['description のキー名は綴りを決め打ちにしない', (() => {
    const ja = ['ja', 'name_ja', '日本語論理名', '論理名'];
    const en = ['en', 'name_en', '英語論理名'];
    return ja.every((k) => Co.parseDesc(JSON.stringify({ [k]: '受注日' })).ja === '受注日') &&
      en.every((k) => Co.parseDesc(JSON.stringify({ [k]: 'order date' })).en === 'order date');
  })()],
  ['拾えなかったキーも捨てずに出す（黙って消えない）', (() => {
    const d = Co.parseDesc('{"name_ja":"リージョン","name_en":"region","unit":"ISO 3166"}');
    return d.rest.length === 1 && d.rest[0].key === 'unit' &&
      d.pairs.length === 3 &&
      columnCases[0].html.includes(
        '<th class="vg-cdk">unit</th><td class="vg-cdv">ISO 3166</td>');
  })()],
  ['JSON として読めなければ素のテキストとして出す', (() => {
    return Co.parseDesc('{ 壊れた JSON').raw === '{ 壊れた JSON' &&
      Co.parseDesc('受注日（JST）').raw === '受注日（JST）' &&
      Co.parseDesc('[1,2]').raw === '[1,2]' &&
      Co.parseDesc('') === null && Co.parseDesc(null) === null &&
      Co.descHtml(null) === '';
  })()],
  ['カラム定義が取れなければ案内を出す（表は出さない）',
    columnCases[3].html.includes('カラム定義を取得できませんでした') &&
    !columnCases[3].html.includes('vg-ctable')],
  // 要素の重要度どおりの大小になっているか。同じ大きさで並べると、どれを先に
  // 読めばよいかが字面から分からなくなる。数字を直すときはここも合わせる。
  ['文字の大きさが重要度の順になっている（型 = 列名 > 説明 > モード）', (() => {
    const css = Co.columnsCss();
    const size = (cls) => {
      const rule = css.split('\n').find((r) => r.indexOf('.' + cls + '{') === 0);
      if (!rule) return null;
      const m = rule.match(/font(?:-size)?:\s*(\d+)px/);
      return m ? Number(m[1]) : null;
    };
    const type = size('vg-ctable');      // セルの本体（型）は表の地の大きさ
    const name = size('vg-cname');
    const head = size('vg-chead');
    const desc = size('vg-cdesc');
    const meta = size('vg-cmeta');
    const val = size('vg-cdv');
    const key = size('vg-cdk');
    const who = size('vg-cdescwho');
    // 型と列名は行の主役なので同じ大きさ。そこから 1 段ずつ落とす。
    return type === 12 && name === 12 && head === 11 && desc === 11 &&
      val === 11 && key === 10 && who === 10 && meta === 8 &&
      type === name && name > val && val > key && key > meta;
  })()],
  ['カラム定義の CSS は columns.js 側にある',
    Co.columnsCss().includes('.vg-ctable') && !R.chromeCss().includes('.vg-ctable')],
  // SQL タブ。ロジック差分が出すのはパラメータ化した SQL なので、素のテキストを
  // 読みたいときの受け皿がここになる。インナーのタブは View（suffix）単位。
  ['SQL のインナー タブは View 単位で suffix 順', (() => {
    const h = sqlCases[0].html;
    const tabs = [...h.matchAll(/class="vg-stab vg-st\d+"[^>]*>([^<]*)</g)].map((m) => m[1]);
    const want = base3.groups.flatMap((g, i) =>
      g.suffixes.map((s, j) => s || g.members[j].viewName)).sort();
    return tabs.length === base3.viewCount && tabs.join(',') === want.join(',');
  })()],
  ['SQL は素のテキストを出す（パラメータ化しない）', (() => {
    const h = sqlCases[0].html;
    // 差分側は {{P1}} に置き換えた SQL を出すが、こちらは置き換えない。
    // View 名そのもの（v_daily_sales_abjp）ではなく参照先が入っているのが素の証拠。
    return !h.includes('{{P') && h.includes('vg-sqlpre') &&
      h.includes('orders_abjp') && h.includes('orders_efus');
  })()],
  ['SQL に行番号が本文として入る（CSS のカウンタに頼らない）', (() => {
    const h = sqlCases[0].html;
    const body = Sq.sqlBody('SELECT 1\nFROM t\nWHERE x = 2');
    return h.includes('<span class="vg-sqln">') &&
      body.lines === 3 &&
      body.html.includes('<span class="vg-sqln">1</span> SELECT 1') &&
      body.html.includes('<span class="vg-sqln">3</span> WHERE x = 2');
  })()],
  ['SQL の 1 桁を超える行番号は空白で桁をそろえる', (() => {
    const body = Sq.sqlBody(new Array(11).fill('SELECT 1').join('\n'));
    return body.lines === 11 &&
      body.html.includes('<span class="vg-sqln"> 1</span>') &&
      body.html.includes('<span class="vg-sqln">10</span>');
  })()],
  ['SQL は折り返さず箱ごと横スクロールする（字下げが構造を表すため）', (() => {
    const css = Sq.sqlCss();
    return /\.vg-sqlbox\{overflow-x:auto/.test(css) &&
      /\.vg-sqlpre\{[^}]*white-space:pre[;}]/.test(css);
  })()],
  ['SQL のパネルに View 名と属するグループを出す', (() => {
    const h = sqlCases[0].html;
    return h.includes('<span class="vg-sqlname">v_daily_sales_abjp</span>') &&
      h.includes('グループ: abjp, abuk, abus');
  })()],
  ['SQL が取れなければ案内を出す（タブは出さない）',
    sqlCases[1].html.includes('SQL を取得できませんでした') &&
    !sqlCases[1].html.includes('vg-stablist')],
  ['SQL タブのラジオは外側・基準・比較と別のクラス（連動しない）', (() => {
    const h = sqlCases[0].html;
    const css = Sq.sqlCss();
    return /class="vg-sr vg-sr1"/.test(h) &&
      !/class="vg-r vg-sr/.test(h) && !/class="vg-br vg-sr/.test(h) &&
      // 形は「兄弟 > 子」から動かさない（この viz で動くと確認できている形）
      css.includes('.vg-sr1:checked ~ .vg-spanels > .vg-sp1{display:block}') &&
      css.includes('.vg-sr1:checked ~ .vg-stablist > .vg-st1') &&
      // 結合子は ~ と > だけ。子孫結合子や * を使うと実機で効かなくなる
      css.split('\n').filter((r) => r.includes(':checked')).every((r) =>
        /^\.[\w-]+:checked(?: [~>] \.[\w-]+)+\{/.test(r));
  })()],
  ['SQL タブの CSS が上限枚数ぶんある', (() => {
    const css = Sq.sqlCss();
    return [...Array(Ch.MAX_SQL_TABS).keys()].every((i) =>
      css.includes(`.vg-sr${i + 1}:checked ~ .vg-spanels > .vg-sp${i + 1}`)) &&
      !css.includes(`.vg-sr${Ch.MAX_SQL_TABS + 1}:checked`);
  })()],
  ['SQL の CSS は sqltext.js 側にある',
    Sq.sqlCss().includes('.vg-sqlpre') && !R.chromeCss().includes('.vg-sqlpre')],
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
    chromeCss() + '\n' + Md.memoCss() + '\n' + Co.columnsCss() + '\n' + Sq.sqlCss() +
    '\n' + V.descCss() +
    '\n</style>\n</head>\n<body>\n' +
    pageCases.concat(parts, noteCases, memoCases, columnCases, sqlCases)
      .map((p) => `<h2>${p.title}</h2>\n${p.html}`).join('\n') +
    '\n</body>\n</html>\n';
  await mkdir(join(here, 'dist'), { recursive: true });
  const out = join(here, 'dist', 'preview.html');
  await writeFile(out, page);
  console.log(`wrote ${out}`);
}

process.exit(failed === 0 ? 0 : 1);
