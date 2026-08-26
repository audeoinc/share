// suffix 違い View のロジック グループ比較を BigQuery の JS UDF にする。
//
//   node build_udf.mjs          -> view_group_html.sql を生成
//   node build_udf.mjs --check  -> 生成せず、Node 上で UDF 本体を実行して検証だけ
//
// 生成するのは 6 つ:
//   viewlgc_analyze(views ARRAY<STRUCT<view_name STRING, ddl STRING>>, options_json STRING) -> JSON
//   viewlgc_render(analysis_json STRING, options_json STRING) -> HTML
//   viewlgc_page(analysis_json STRING, diff_html STRING, options_json STRING) -> HTML
//   viewlgc_markdown(md STRING) -> HTML   -- base ごとのメモ。ビューの中から呼ぶ
//   viewlgc_group_css(options_json STRING)
//   viewlgc_render_dynamic_sql(...)  -- SQL 関数。build_table.sql の __…__ を展開する
//
// HTML とメタデータ（グループ数・ラベル）を 1 回の呼び出しで返すのは、
// 事前生成テーブルに両方入れたいため。分けると同じ解析を 2 回走らせることになる。
// 数値を FLOAT64 で返しているのは JS UDF が INT64 を扱えないため。SQL 側で CAST する。
//
// サイズについて:
//   BigQuery の UDF はインラインのコード ブロブが 32 KB までに制限される
//   （標準 SQL でも同じ）。素の連結は約 45 KB あって確実に弾かれるため、
//   esbuild で最小化してから埋め込む。生成時に閾値を超えたら失敗させて、
//   BigQuery に弾かれるものを出荷しないようにしている。
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

// 生成する SQL の DECLARE / SET @@location に入れる既定値。
// 実際の値は生成後の view_group_html.sql の先頭で書き換える。
// build_table.sql と同じロケーションにしないと、作った UDF を参照できない。
const region = 'asia-northeast1';

// インラインで埋め込んでよい上限。32 KB に対して余裕を持たせる。
const SIZE_LIMIT = 30 * 1024;

// 解析側と描画側は別々の UDF にする。インラインのコード ブロブは 1 個あたり
// 32 KB までなので、1 本にまとめると枠が 1 つしか使えない。依存も素直に割れる
// （解析は analyze.js だけ、描画は diff/render/render_groups だけ）。
// JS UDF の中から別の UDF は呼べないので、つなぐのは呼び出し側の SQL。
const ANALYZE_SOURCES = [
  ['analyze.js', join(here, 'analyze.js')],
];
const RENDER_SOURCES = [
  ['chrome.js', join(here, 'chrome.js')],
  ['lib/diff.js', join(here, '..', 'ddl_diff_viz', 'src', 'lib', 'diff.js')],
  ['lib/render.js', join(here, '..', 'ddl_diff_viz', 'src', 'lib', 'render.js')],
  ['render_groups.js', join(here, 'render_groups.js')],
];
// 参照関係の UDF。差分エンジン（diff.js / render.js）は要らないので積まない。
// 積むと 1 個 32 KB のインライン上限に収まらなくなる。
const ERD_SOURCES = [
  ['chrome.js', join(here, 'chrome.js')],
  ['analyze.js', join(here, 'analyze.js')],
  ['erd.js', join(here, 'erd.js')],
];
// base ごとのメモ（Markdown）の UDF。ほかとは何も共有しない。
// これだけビューの中から呼ぶ（＝クエリのたびに走る）ので、事前生成の
// テーブルには焼き込まない。焼き込むと次の日次実行までメモが古いままになる。
const MARKDOWN_SOURCES = [
  ['markdown.js', join(here, 'markdown.js')],
];
// テンプレートに貼る CSS は 1 枚にまとめて配る。差分カード側の chromeCss() と
// メモ側の memoCss() を両方持つ必要があるので、CSS の UDF だけ両方を積む。
// markdown.js の描画側は要らないので下の UNUSED_CSS で落とす。
const CSS_SOURCES = RENDER_SOURCES.concat([['markdown.js', join(here, 'markdown.js')]]);

/**
 * 使わないトップレベル関数を落とす。
 *
 * 3 ペイン横並びは使わない方針にしたので、3-way 系の関数を UDF から外す。
 * インラインの 32 KB 枠がぎりぎりなので、載せない分だけ余裕になる。
 *
 * esbuild は format を指定しない限り未使用のトップレベル宣言を残す
 * （指定するとラップされて必要なものまで落ちる）ため、ここで明示的に削る。
 * 消しすぎればこの後の実行検証で必ず落ちるので、取り違えは検出できる。
 */
function dropFunctions(src, names) {
  let out = src;
  for (const name of names) {
    // `function name(` から、列 0 の `}` までを 1 つの宣言とみなす
    const re = new RegExp(`^function ${name}\\([\\s\\S]*?^\\}\\n`, 'm');
    if (!re.test(out)) throw new Error(`dropFunctions: ${name} が見つかりません`);
    out = out.replace(re, '');
    if (new RegExp(`^function ${name}\\(`, 'm').test(out)) {
      throw new Error(`dropFunctions: ${name} が残っています`);
    }
  }
  return out;
}

// 3 ペイン横並びを使わないので不要になったもの。
// build3Way / mapToBase / baseCell / segsText は 3-way 専用。
// alphaMap は alphaMapDetail の薄い包み。UDF は Detail 側しか呼ばない。
const UNUSED_ANALYZE = ['alphaMap'];
// ERD 側はグループ化もパラメータ化もしない。トークナイザと実体名の判定だけ使う。
const UNUSED_ERD = ['alphaMap', 'alphaMapDetail', 'parameterize', 'groupByLogic',
  'analyze', 'maskTokens', 'buildLiteralMap', 'suffixWords', 'parseEquivalents',
  'extractSuffix', 'expandSuffixParts', 'normalizeSpace'];
const UNUSED_RENDER = ['renderFragment3', 'build3Way', 'mapToBase', 'baseCell', 'segsText'];
// CSS の UDF は markdown.js から memoCss() しか呼ばない。Markdown を HTML に
// する側は viewlgc_markdown が持っているので、こちらには積まない。
const UNUSED_CSS = UNUSED_RENDER.concat([
  'markdownHtml', 'mdRender', 'mdBlocks', 'mdList', 'mdAligns', 'mdCells',
  'mdKind', 'mdIndent', 'mdInline', 'mdLink', 'mdUrl', 'mdEsc']);

/** CommonJS の体裁を落として素の関数群にする。 */
function strip(src, file) {
  const out = src
    .replace(/^'use strict';\s*$/m, '')
    .replace(/^const\s*\{[^}]*\}\s*=\s*require\([^)]*\);\s*$/gm, '')
    .replace(/^module\.exports\s*=[\s\S]*?\};\s*$/m, '')
    .replace(/^module\.exports\s*=[^;]*;\s*$/m, '');
  if (/\brequire\s*\(/.test(out) || /\bmodule\.exports\b/.test(out)) {
    throw new Error(`${file}: require / module.exports が残っています`);
  }
  if (out.includes('"""')) {
    throw new Error(`${file}: 三重引用符が含まれており raw string を壊します`);
  }
  return out.trim();
}

async function bundle(sources, unused) {
  const libs = [];
  for (const [name, path] of sources) {
    libs.push(strip(await readFile(path, 'utf8'), name));
  }
  return dropFunctions(libs.join('\n\n'), unused);
}
const analyzeLib = await bundle(ANALYZE_SOURCES, UNUSED_ANALYZE);
const renderLib = await bundle(RENDER_SOURCES, UNUSED_RENDER);
const erdLib = await bundle(ERD_SOURCES, UNUSED_ERD);
const markdownLib = await bundle(MARKDOWN_SOURCES, []);
const cssLib = await bundle(CSS_SOURCES, UNUSED_CSS);

// --- 共通ヘルパ（DIFF_HTML と同じ考え方） ------------------------------
// 両方の UDF に入れるもの。
const sharedBase = `
function __opts(options_json) {
  if (!options_json) return {};
  try { return JSON.parse(options_json) || {}; } catch (e) { return {}; }
}

function __notice(text) {
  return '<div class="vg-notice">' + String(text).replace(/[<>&]/g, '') + '</div>';
}
`.trim();

// 描画側の UDF にだけ入れるもの。chromeCss() を使うので解析側には入らない。
const sharedRender = `
/* style 属性の中身のハッシュからクラス名を決める。内容や出現順に依存しないので、
   テンプレート側の固定 CSS と markup 側のクラス名がズレない。 */
function __hashClass(s) {
  var h = 0x811c9dc5;
  for (var i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return 'd' + h.toString(36);
}

function __split(html) {
  var rules = {};
  var markup = html.replace(/ style="([^"]*)"/g, function (_m, css) {
    var cls = __hashClass(css);
    rules[cls] = css;
    return ' class="' + cls + '"';
  });
  return { markup: markup, rules: rules };
}

function __rulesToCss(rules) {
  var keys = Object.keys(rules).sort();
  var out = [];
  for (var i = 0; i < keys.length; i++) out.push('.' + keys[i] + '{' + rules[keys[i]] + '}');
  return out.join('\\n');
}

function __applyMode(html, mode) {
  if (mode === 'class') return __split(html).markup;
  if (mode === 'embed') {
    var s = __split(html);
    return '<style>\\n' + chromeCss() + '\\n' + __rulesToCss(s.rules) + '\\n</style>\\n' + s.markup;
  }
  return html;
}
`.trim();

// --- analyze のドライバ ------------------------------------------------
// 解析結果を JSON で返す。描画側の UDF がそれを受け取って HTML にする。
// 渡すのは描画に要る分だけに削る。members の tokens / raw / ddl を積むと
// サンプル 9 本で 62 KB になるが、削れば 3 KB で済む（描画結果は同じ）。
const analyzeDriver = `
function __trimBase(bs) {
  var groups = [];
  for (var i = 0; i < bs.groups.length; i++) {
    var g = bs.groups[i];
    var members = [];
    for (var j = 0; j < g.members.length; j++) {
      members.push({ viewName: g.members[j].viewName });
    }
    groups.push({
      suffixes: g.suffixes, members: members,
      // missBy は「どのグループを基準にしたときの差か」の行列。基準を
      // レポート側で選べるようにしたので、描画側にも渡す必要がある。
      sql: g.sql, params: g.params, miss: g.miss, missBy: g.missBy
    });
  }
  return {
    base: bs.base, viewCount: bs.viewCount, groupCount: bs.groupCount,
    unmatched: bs.unmatched, groups: groups
  };
}

function __label(g) {
  var out = [];
  for (var i = 0; i < g.suffixes.length; i++) {
    out.push(g.suffixes[i] || (g.members[i] && g.members[i].viewName) || '(suffix なし)');
  }
  return out.join(', ');
}

function __payload(lead) {
  return {
    viewCount: 0, groupCount: 0, groupLabels: [], groupSizes: [],
    suffixes: [], unmatchedCount: 0, bases: [], lead: lead || '', tail: ''
  };
}

function __run(views, options_json) {
  var opts = __opts(options_json);
  if (!views || views.length === 0) {
    return JSON.stringify(__payload('View が渡されていません。'));
  }

  var rows = [];
  for (var i = 0; i < views.length; i++) {
    if (views[i]) rows.push({ view_name: views[i].view_name, ddl: views[i].ddl });
  }

  var res = analyze(rows, opts);
  if (res.bases.length === 0) {
    var e = __payload(rows.length + ' 件すべて suffix を認識できませんでした。' +
      'suffixParts / suffixList / suffixPattern の指定を確認してください。');
    e.unmatchedCount = res.unmatched.length;
    return JSON.stringify(e);
  }

  // 呼び出し側で base ごとに束ねている前提。混ざっていても全部返す。
  var out = __payload('');
  for (var b = 0; b < res.bases.length; b++) {
    var bs = res.bases[b];
    out.bases.push(__trimBase(bs));
    out.viewCount += bs.viewCount;
    out.groupCount += bs.groupCount;
    for (var g = 0; g < bs.groups.length; g++) {
      var grp = bs.groups[g];
      // suffix が null（未認識）のときは View 名。表示の見出しと同じ規則にする。
      out.groupLabels.push(__label(grp));
      out.groupSizes.push(grp.members.length);
      for (var k = 0; k < grp.suffixes.length; k++) {
        out.suffixes.push(grp.suffixes[k] || grp.members[k].viewName);
      }
    }
  }
  out.suffixes.sort();
  out.unmatchedCount = res.unmatched.length;
  // 未認識の View は base として描いてある（includeUnmatched: false のときだけ案内）
  if (res.unmatched.length > 0 && opts.includeUnmatched === false) {
    out.tail = 'suffix を認識できなかった View が ' + res.unmatched.length + ' 件あります。';
  }
  return JSON.stringify(out);
}

return __run(views, options_json);
`.trim();

// --- render のドライバ -------------------------------------------------
// analyze の JSON を受け取って HTML にする。解析はしない。
const renderDriver = `
function __run(analysis_json, options_json) {
  var opts = __opts(options_json);
  var a;
  try { a = JSON.parse(analysis_json); } catch (e) { a = null; }
  if (!a) return __notice('解析結果を読み取れませんでした。');

  var html = a.lead ? __notice(a.lead) : '';
  var bases = a.bases || [];
  for (var i = 0; i < bases.length; i++) html += renderBase(bases[i], opts);
  if (a.tail) html += __notice(a.tail);
  return __applyMode(html, opts.mode || 'inline');
}

return __run(analysis_json, options_json);
`.trim();

// --- page のドライバ ---------------------------------------------------
// 解析結果から参照関係の図を作り、渡された差分 HTML と外側タブで束ねる。
// 差分そのものは作らない（差分エンジンを積むと 32 KB に収まらないため）。
const pageDriver = `
function __run(analysis_json, diff_html, options_json) {
  var opts = __opts(options_json);
  var a;
  try { a = JSON.parse(analysis_json); } catch (e) { a = null; }
  if (!a) return String(diff_html || __notice('解析結果を読み取れませんでした。'));

  var erd = '';
  var bases = a.bases || [];
  for (var i = 0; i < bases.length; i++) erd += renderErdBase(bases[i], opts);
  if (!erd) erd = __notice('図にできる View がありません。');
  return wrapPage(String(diff_html || ''), erd, a.bases && a.bases.length ? a.bases[0].base : '');
}

return __run(analysis_json, diff_html, options_json);
`.trim();

// --- markdown のドライバ -----------------------------------------------
// メモの Markdown を HTML にする。空・NULL でも枠を返す（呼び出し側の
// COALESCE を要らなくする）。ビューの中から呼ぶので、落ちないことが要件。
const markdownDriver = `
function __run(md) {
  try { return markdownHtml(md); }
  catch (e) { return __notice('メモを表示できませんでした: ' + e); }
}

return __run(md);
`.trim();

// --- group_css のドライバ ----------------------------------------------
// 全パターンを描画して、そこに出る規則を集める。markup と同じコードから作るので
// クラス名が食い違わない。chromeCss() はもともとクラス方式なのでそのまま足す。
//
// fixture は analyze() を通さず手で組む。解析側の UDF と分けた以上、
// CSS のためだけに analyze.js を積むと 7 KB を無駄にするため。
// 手組みが実物とズレていないかは、生成時のクラス網羅チェックが見張る。
const cssDriver = `
function __fixtureRules(opts) {
  var rules = {};
  function collect(b) {
    var r = __split(renderBase(b, opts)).rules;
    for (var k in r) rules[k] = r[k];
  }
  function grp(sufs, sql, params, miss) {
    var members = [];
    for (var i = 0; i < sufs.length; i++) members.push({ viewName: 'v_fixture_' + sufs[i] });
    return { suffixes: sufs, members: members, sql: sql, params: params || [], miss: miss };
  }
  function base(name, groups, unmatched) {
    var n = 0;
    for (var i = 0; i < groups.length; i++) n += groups[i].members.length;
    return {
      base: name, viewCount: n, groupCount: groups.length,
      unmatched: unmatched, groups: groups
    };
  }

  // 差分の見た目（追加 / 削除 / 変更 / ハッチ）が全部出るように SQL を作る。
  var A = 'SELECT\\n  a,\\n  b\\nFROM t_{{P1}}\\nWHERE x = 1';
  var B = 'SELECT\\n  a,\\n  c.b\\nFROM t_{{P1}}\\nLEFT JOIN u_{{P1}} AS c USING (a)\\nWHERE x = 2';
  var C = 'SELECT\\n  a\\nFROM t_{{P1}}\\nWHERE x = 1';
  var P = [{ name: '{{P1}}', values: { abjp: 't_abjp', abus: 't_abus' } }];
  var MISS = { vs: 'abjp, abus', detail: {
    reason: 'not-substitutable', kind: 'string', aText: "'apac'", bText: "'amer'" } };

  // 1 グループ（基準タブ 1 枚 ＋ 1 ペイン）。params 無しの「差分なし」も出す。
  collect(base('v_fixture_one', [grp(['abjp', 'abus'], A, [])]));
  // 2 グループ（基準 ＋ 比較 1 枚）。パラメータ表と「なぜ別グループか」も出す。
  collect(base('v_fixture_two', [grp(['abjp', 'abus'], A, P), grp(['cdjp'], B, P, MISS)]));
  // 3 グループ以上（タブが増える）
  collect(base('v_fixture_many', [
    grp(['abjp', 'abus'], A, P), grp(['cdjp'], B, P, MISS), grp(['efjp'], C, P, MISS)]));
  // suffix 未認識（単独表示。バッジが 1 つ増える）
  collect(base('v_fixture_no_suffix',
    [{ suffixes: [null], members: [{ viewName: 'v_fixture_no_suffix' }],
       sql: A, params: [] }], true));

  return rules;
}

return chromeCss() + '\\n' + memoCss() + '\\n' +
  __rulesToCss(__fixtureRules(__opts(options_json)));
`.trim();

// --- 最小化 -------------------------------------------------------------
let esbuild = null;
try {
  const req = createRequire(join(here, '..', 'ddl_diff_viz', 'package.json'));
  esbuild = req('esbuild');
} catch {
  console.warn('WARN: esbuild が見つからないため最小化をスキップします');
  console.warn('      (looker_studio/ddl_diff_viz で npm install してください)');
}

function pack(driver, label, lib, extra) {
  const raw = [lib, '', sharedBase, '', extra || '', '', driver].join('\n');
  if (!esbuild) return { code: raw, raw: raw.length, min: null, label };
  // format を指定するとラップされて未使用の関数が落ちるので、指定しない
  const min = esbuild.transformSync(raw, { loader: 'js', minify: true, target: 'es2017' }).code;
  // 最小化器は '\u0001' のような文字列を生の制御文字として書き出す。
  // そのまま SQL に埋めると、生成物に見えない文字が混ざり、エディタでも
  // BigQuery のエラーでも追えなくなる。JS のエスケープに戻してから埋める。
  // 制御文字が出るのは文字列・正規表現リテラルの中だけなので、置換して等価。
  const code = min.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g,
    (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
  return { code, raw: raw.length, min: code.length, label };
}

const analyzePack = pack(analyzeDriver, 'viewlgc_analyze', analyzeLib);
const renderPack = pack(renderDriver, 'viewlgc_render', renderLib, sharedRender);
const cssPack = pack(cssDriver, 'viewlgc_group_css', cssLib, sharedRender);
const pagePack = pack(pageDriver, 'viewlgc_page', erdLib);
const markdownPack = pack(markdownDriver, 'viewlgc_markdown', markdownLib);

// --- 検証: 最小化した本体をそのまま実行する -----------------------------
const S = require(join(here, 'sample_views.js'));
const VIEWLGC_ANALYZE = new Function('views', 'options_json', analyzePack.code);
const VIEWLGC_RENDER = new Function('analysis_json', 'options_json', renderPack.code);
const VIEWLGC_PAGE = new Function('analysis_json', 'diff_html', 'options_json', pagePack.code);
const VIEWLGC_MARKDOWN = new Function('md', markdownPack.code);
const VIEW_GROUP_CSS = new Function('options_json', cssPack.code);

// JS UDF から別の UDF は呼べないので、つなぐのは呼び出し側の SQL の仕事。
// ここではその合成を JS で再現して、分割前と同じ検証をそのまま通す。
// build_table.sql も同じ順（analyze を 1 回 → その結果を render へ）で呼ぶ。
function VIEW_GROUP_INFO(views, options_json) {
  const a = VIEWLGC_ANALYZE(views, options_json);
  const j = JSON.parse(a);
  return {
    view_count: j.viewCount,
    group_count: j.groupCount,
    group_labels: j.groupLabels,
    group_sizes: j.groupSizes,
    suffixes: j.suffixes,
    unmatched_count: j.unmatchedCount,
    html: VIEWLGC_RENDER(a, options_json),
    // build_table.sql は render の結果をさらに page へ渡す。ここも同じ順で通し、
    // 最小化した page 本体が実際に動くことを確かめる。
    page: VIEWLGC_PAGE(a, VIEWLGC_RENDER(a, options_json), options_json),
  };
}

const views = S.sampleRows().map((r) => ({ view_name: r.view_name, ddl: r.ddl }));
const OPTS = JSON.stringify({ suffixParts: S.SUFFIX_PARTS });
const info = VIEW_GROUP_INFO(views, OPTS);
const html = info.html;
const classed = VIEW_GROUP_INFO(views, JSON.stringify({ suffixParts: S.SUFFIX_PARTS, mode: 'class' })).html;
const embed = VIEW_GROUP_INFO(views, JSON.stringify({ suffixParts: S.SUFFIX_PARTS, mode: 'embed' })).html;
const css = VIEW_GROUP_CSS(JSON.stringify({ suffixParts: S.SUFFIX_PARTS }));

const text = html.replace(/<[^>]*>/g, '');

// 複雑な SQL を最小化後の本体に通す（多段 CTE / 名前付きウィンドウ / QUALIFY /
// UNION / UNNEST / 相関サブクエリ）。素の analyze.js では test.mjs が見ている。
const C = require(join(here, 'sample_complex.js'));
const COMPLEX_OPTS = JSON.stringify({ suffixParts: C.COMPLEX_PARTS });
const COMPLEX = VIEW_GROUP_INFO(
  C.complexRows().map((r) => ({ view_name: r.view_name, ddl: r.ddl })), COMPLEX_OPTS);
const COMPLEX_SPLIT = VIEW_GROUP_INFO(
  C.complexRows({ abus: (q) => q.replace('AS gross_amount', 'AS total_amount') })
    .map((r) => ({ view_name: r.view_name, ddl: r.ddl })), COMPLEX_OPTS);
// クラスの網羅は全レイアウトで見る。タブ（3 グループ）だけを見ていると、
// 1 ペインや suffix 未認識の描き分けで増えたクラスを取りこぼす。
// 取りこぼすと、テンプレートに貼った CSS を貼り直すまでそこだけ素で表示される。
const classedAll = [
  classed,
  VIEW_GROUP_INFO(views.filter((v) => v.view_name.includes('_ab')),
    JSON.stringify({ suffixParts: S.SUFFIX_PARTS, mode: 'class' })).html,
  VIEW_GROUP_INFO([{ view_name: 'no_suffix_here', ddl: 'SELECT 1' }],
    JSON.stringify({ suffixParts: S.SUFFIX_PARTS, mode: 'class' })).html,
].join('');
const used = [...new Set([...classedAll.matchAll(/class="(d[0-9a-z]+)"/g)].map((m) => m[1]))];
const defined = new Set([...css.matchAll(/^\.(d[0-9a-z]+)\{/gm)].map((m) => m[1]));

const checks = [
  ['最小化後も動く（HTML を生成）', html.includes('vg-root')],
  ['page も最小化後に動く（外側タブと図が出る）',
    info.page.includes('vg-otab') && info.page.includes('<svg ') &&
    info.page.includes(html)],
  ['タイトルが base 名', text.includes('v_daily_sales')],
  ['3 グループでタブになる', html.includes('vg-tablist')],
  ['ペイン見出しに suffix が列記される', text.includes('abjp, abuk, abus')],
  ['パラメータ一覧が付く', text.includes('パラメータ化した箇所')],
  ['class モードは style 属性を残さない', !/ style="/.test(classed)],
  ['group_css が markup の全クラスを網羅', used.every((c) => defined.has(c))],
  ['group_css に chrome の規則が入る', css.includes('.vg-tablist') && css.includes('.vg-r1:checked')],
  ['embed モードは style ブロックを含む', embed.includes('<style>') && embed.includes('.vg-panel')],
  ['メタデータ: View 数', info.view_count === 9],
  ['メタデータ: グループ数', info.group_count === 3],
  ['メタデータ: グループ ラベル',
    info.group_labels.join(' | ') === 'abjp, abuk, abus | cdjp, cduk, cdus | efjp, efuk, efus'],
  ['メタデータ: グループの規模', info.group_sizes.join(',') === '3,3,3'],
  ['メタデータ: suffix 一覧', info.suffixes.length === 9 && info.suffixes[0] === 'abjp'],
  ['メタデータ: 未認識は 0', info.unmatched_count === 0],
  ['空入力で案内を返す',
    VIEW_GROUP_INFO([], OPTS).html.includes('View が渡されていません')],
  ['suffix 未認識でもソースを単独で描く',
    (() => {
      const r = VIEW_GROUP_INFO([{ view_name: 'no_suffix_here', ddl: 'SELECT 1' }], OPTS);
      const t = r.html.replace(/<[^>]*>/g, '');
      return r.view_count === 1 && r.group_count === 1 && r.unmatched_count === 1 &&
        r.group_labels.join('') === 'no_suffix_here' &&
        t.includes('no_suffix_here') && t.includes('suffix を認識できなかった View です');
    })()],
  ['suffix 未認識は includeUnmatched:false で従来どおり除外できる',
    VIEW_GROUP_INFO([{ view_name: 'no_suffix_here', ddl: 'SELECT 1' }],
      JSON.stringify({ suffixParts: S.SUFFIX_PARTS, includeUnmatched: false }))
      .html.includes('suffix を認識できませんでした')],
  ['未認識の View は混在していても描かれる',
    (() => {
      const r = VIEW_GROUP_INFO(
        S.sampleRows().concat([{ view_name: 'v_daily_sales_zzz', ddl: 'SELECT 1' }]), OPTS);
      return r.view_count === 10 && r.unmatched_count === 1 &&
        r.html.replace(/<[^>]*>/g, '').includes('v_daily_sales_zzz');
    })()],
  ['リテラルの suffix 連動コードを吸収する',
    VIEW_GROUP_INFO([
      { view_name: 'v_c_abjp', ddl: "SELECT a FROM t_abjp WHERE c = 'JP'" },
      { view_name: 'v_c_abus', ddl: "SELECT a FROM t_abus WHERE c = 'US'" },
    ], OPTS).group_count === 1],
  ['値の差は既定でパラメータ化して同じグループにする',
    VIEW_GROUP_INFO([
      { view_name: 'v_c_abjp', ddl: "SELECT a FROM t_abjp WHERE s = 'A'" },
      { view_name: 'v_c_abus', ddl: "SELECT a FROM t_abus WHERE s = 'B'" },
    ], OPTS).group_count === 1],
  ['substitutable を絞れば値の差を残せる',
    VIEW_GROUP_INFO([
      { view_name: 'v_c_abjp', ddl: "SELECT a FROM t_abjp WHERE s = 'A'" },
      { view_name: 'v_c_abus', ddl: "SELECT a FROM t_abus WHERE s = 'B'" },
    ], JSON.stringify({ suffixParts: S.SUFFIX_PARTS, substitutable: ['entity'] }))
      .group_count === 2],
  ['列名が違えば別グループ',
    VIEW_GROUP_INFO([
      { view_name: 'v_c_abjp', ddl: 'SELECT amount FROM t_abjp' },
      { view_name: 'v_c_abus', ddl: 'SELECT revenue FROM t_abus' },
    ], OPTS).group_count === 2],
  ['CTE 名が違えば別グループ',
    VIEW_GROUP_INFO([
      { view_name: 'v_c_abjp', ddl: 'WITH d AS (SELECT a FROM t_abjp) SELECT * FROM d' },
      { view_name: 'v_c_abus', ddl: 'WITH e AS (SELECT a FROM t_abus) SELECT * FROM e' },
    ], OPTS).group_count === 2],
  ['バッククォートの有無が違えば別グループ',
    VIEW_GROUP_INFO([
      { view_name: 'v_c_abjp', ddl: 'SELECT a FROM `p.d.t_abjp`' },
      { view_name: 'v_c_abus', ddl: 'SELECT a FROM p.d.t_abus' },
    ], OPTS).group_count === 2],
  ['literalGroups で手動の同値リテラルを吸収する',
    VIEW_GROUP_INFO([
      { view_name: 'v_g_abjp', ddl: "SELECT a FROM t_abjp WHERE z = 'apac'" },
      { view_name: 'v_g_abus', ddl: "SELECT a FROM t_abus WHERE z = 'amer'" },
    ], JSON.stringify({ suffixParts: S.SUFFIX_PARTS,
      literalGroups: [['apac', 'amer', 'emea']] })).group_count === 1],
  ['literalGroups にない値は残す（substitutable を絞ったとき）',
    VIEW_GROUP_INFO([
      { view_name: 'v_g_abjp', ddl: "SELECT a FROM t_abjp WHERE z = 'apac'" },
      { view_name: 'v_g_abus', ddl: "SELECT a FROM t_abus WHERE z = 'zzz'" },
    ], JSON.stringify({ suffixParts: S.SUFFIX_PARTS, substitutable: ['entity'],
      literalGroups: [['apac', 'amer', 'emea']] })).group_count === 2],
  ['壊れた options_json でも落ちない',
    typeof VIEW_GROUP_INFO(views, '{ broken').html === 'string'],
  ['script タグを含まない', !/<script/i.test(html)],
  // 分割の要。解析結果は UDF 間を JSON で渡るので、素の解析結果をそのまま
  // 積むと 60 KB を超える。描画に要る分だけに削れているかを見る。
  ['解析結果の受け渡しが小さい（描画に要る分だけ）',
    Buffer.byteLength(VIEWLGC_ANALYZE(views, OPTS)) < 8 * 1024],
  ['解析結果に tokens / ddl を積んでいない',
    !/"tokens"|"ddl"|"raw"/.test(VIEWLGC_ANALYZE(views, OPTS))],
  ['render は壊れた JSON でも落ちない',
    typeof VIEWLGC_RENDER('{ broken', OPTS) === 'string'],
  // 複雑な SQL（多段 CTE / ウィンドウ / UNION / UNNEST / 相関サブクエリ）が
  // 最小化した本体でも通ること。単純な SELECT だけだと実体名の検出が素通りする。
  ['複雑な SQL でもコピー展開なら 1 グループ', COMPLEX.group_count === 1],
  ['複雑な SQL でも HTML を返す',
    COMPLEX.html.includes('vg-root') &&
    COMPLEX.html.replace(/<[^>]*>/g, '').includes('QUALIFY')],
  ['複雑な SQL のパラメータは実体名と値だけ',
    COMPLEX.group_labels.length === 1 &&
    /orders_/.test(JSON.stringify(COMPLEX.suffixes)) === false],
  ['複雑な SQL で列名を変えると割れる', COMPLEX_SPLIT.group_count === 2],
  // メモ（Markdown）。ビューの中から呼ぶので、落ちないことと、出すクラスが
  // すべて group_css に定義されていることが要件。定義が無いと、テンプレートに
  // CSS を貼っていても表だけ罫線なしで出るような崩れ方をする。
  ['markdown が最小化後も動く',
    VIEWLGC_MARKDOWN('# 見出し\n\n- a\n- b').includes('<h1 class="vg-mdh1">')],
  ['markdown は空・NULL でも枠を返す',
    VIEWLGC_MARKDOWN(null).includes('vg-mdempty') &&
    VIEWLGC_MARKDOWN('   ').includes('vg-mdempty')],
  ['markdown は生の HTML を通さない',
    !/<script/i.test(VIEWLGC_MARKDOWN('<script>alert(1)</script>')) &&
    !/href="javascript/i.test(VIEWLGC_MARKDOWN('[x](javascript:alert(1))'))],
  ['markdown の出すクラスが group_css に全部ある', (() => {
    const sample = [
      '# h1', '## h2', '### h3', '#### h4', '##### h5', '###### h6', '',
      'p **b** *i* ~~d~~ `c` [a](https://e.com)', '',
      '| a | b | c |', '|:--|:-:|--:|', '| 1 | 2 | 3 |', '',
      '- x', '  - y', '1. z', '', '> q', '', '```', 'code', '```', '', '---', '',
    ].join('\n');
    const out = VIEWLGC_MARKDOWN(sample) + VIEWLGC_MARKDOWN('');
    const used = [...new Set([...out.matchAll(/class="([^"]+)"/g)]
      .flatMap((m) => m[1].split(' ')))].filter((c) => c.indexOf('vg-md') === 0);
    // 網羅の確認なので、素の chromeCss ではなく実際に配る CSS を見る。
    // 前方一致で数えないよう、定義側もクラス名として取り出して突き合わせる
    // （'.vg-md' は '.vg-mdh1{' にも含まれてしまう）。
    const defined = new Set([...css.matchAll(/\.(vg-md[a-z0-9]*)/g)].map((m) => m[1]));
    return used.length >= 18 && used.every((c) => defined.has(c));
  })()],
  // 最小化するとエスケープの書き方が変わりうるので、リテラルの読み分けが
  // 生き残っているかを本体そのもので見る。割れていれば値の差で別グループになる。
  ['最小化後もリテラルの書き方を取りこぼさない', (() => {
    const D3 = String.fromCharCode(34, 34, 34);
    const pairs = [
      ['n > 1e6', 'n > 2e7'],
      ['n = 0x1F', 'n = 0x2A'],
      ["s = 'it''s'", "s = 'ok'"],
      ["REGEXP_CONTAINS(s, r'^A\\d+$')", "REGEXP_CONTAINS(s, r'^B\\d+$')"],
      ["s = '''alpha'''", "s = '''beta'''"],
      [`s = ${D3}alpha${D3}`, `s = ${D3}beta${D3}`],
    ];
    return pairs.every(([x, y]) => VIEW_GROUP_INFO([
      { view_name: 'v_l_abjp', ddl: 'SELECT a FROM t_abjp WHERE ' + x },
      { view_name: 'v_l_abus', ddl: 'SELECT a FROM t_abus WHERE ' + y },
    ], OPTS).group_count === 1);
  })()],
];

// サイズ検証
for (const p of [analyzePack, renderPack, pagePack, markdownPack, cssPack]) {
  const size = Buffer.byteLength(p.code);
  checks.push([`${p.label} が ${(SIZE_LIMIT / 1024).toFixed(0)} KB 以内`, size <= SIZE_LIMIT]);
}

let failed = 0;
for (const [name, ok] of checks) {
  if (!ok) failed++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}`);
}

const kb = (n) => (n / 1024).toFixed(1) + ' KB';
console.log(`\n${checks.length - failed}/${checks.length} passed\n`);
console.log('UDF 本体のサイズ（インライン上限 32 KB）');
for (const p of [analyzePack, renderPack, pagePack, markdownPack, cssPack]) {
  console.log(`  ${p.label.padEnd(20)} 素 ${kb(p.raw).padStart(8)} → ` +
    (p.min === null ? '最小化なし' : `最小化 ${kb(p.min).padStart(8)}`) +
    `  （上限比 ${(Buffer.byteLength(p.code) / SIZE_LIMIT * 100).toFixed(0)}%）`);
}
console.log(`\n出力 HTML: inline ${kb(Buffer.byteLength(html))} / ` +
  `class ${kb(Buffer.byteLength(classed))} / CSS ${kb(Buffer.byteLength(css))}`);

if (failed > 0) process.exit(1);
if (process.argv.includes('--check')) process.exit(0);

// --- SQL を書き出す ----------------------------------------------------
const sql = `-- =====================================================================
-- suffix 違い View のロジック グループ比較の UDF を作る
--
-- ※ このファイルは build_udf.mjs が生成する。直接編集しないこと。
--    再生成: node looker_studio/view_groups/build_udf.mjs
--    本体は esbuild で最小化してある（インラインのコード ブロブは
--    32 KB までに制限されるため。素の連結は約 48 KB で確実に弾かれる）。
--
-- 作る関数は 6 つ。名前はすべて CONFIGURATION の値から組み立てる。
--   viewlgc_analyze             View 群を解析して JSON を返す（JavaScript）
--   viewlgc_render              その JSON を比較 HTML にする（JavaScript）
--   viewlgc_page                参照関係の図を作り、差分と外側タブで束ねる（JavaScript）
--   viewlgc_markdown            base ごとのメモ（Markdown）を HTML にする（JavaScript）
--   viewlgc_group_css           テンプレートに貼る CSS を返す（JavaScript）
--   viewlgc_render_dynamic_sql  build_table.sql の __…__ を展開する（SQL）
--
-- 解析と描画を分けてあるのは、インラインのコード ブロブが 1 個あたり 32 KB
-- までのため。JS UDF の中から別の UDF は呼べないので、つなぐのは呼び出し側
-- の SQL（build_table.sql が analyze を 1 回呼び、その結果を render に渡す）。
--
-- 命名と設定の書き方は lineage プロジェクト（lineage/sql/setup/
-- 01_setup_lineage_environment.sql）にそろえてある。
--   UDF 名: udf_name_prefix + system_name + '_' + 基本名 + udf_name_suffix
-- =====================================================================


SET @@location = '${region}';

BEGIN
-- ---------------------------------------------------------------------
-- CONFIGURATION（書き換えるのはここだけ）
--
--   [A] 環境ごとに必ず見るもの
--   [B] 既定のままで動くもの
--   [C] 導出・内部用。編集しない
--
--   リージョンは先頭の SET @@location が唯一の置き場所。
--   SET @@location は DECLARE より前に置く。このスクリプトは
--   EXECUTE IMMEDIATE で DDL を投げるだけで、ロケーションを推測できる
--   テーブル参照が無いため、指定しないと既定のロケーションで実行される。
-- ---------------------------------------------------------------------
-- [A] 環境ごとに必ず見るもの ------------------------------------------
-- プロジェクト ID は実行時に自動検出する（[C]）。別プロジェクトに作る
-- ときだけ [C] の udf_project_id にリテラルを入れて固定する。
--
-- プロジェクト トークンの置換
DECLARE project_token_pattern STRING DEFAULT r'^([^-]+)';
-- このシステムを表す名前。すべてのオブジェクト名の先頭に入る
DECLARE system_name STRING DEFAULT 'viewlgc';
-- UDF の置き場所
DECLARE udf_dataset STRING DEFAULT 'ops_meta';
-- UDF の命名（prefix / suffix）
DECLARE udf_name_prefix STRING DEFAULT '';
DECLARE udf_name_suffix STRING DEFAULT '';
--
-- 変数の説明:
--   project_token_pattern
--     自動検出したプロジェクト ID からこの正規表現で切り出したトークン
--     （REGEXP_EXTRACT。キャプチャがあればグループ 1）が、下の名前に書いた
--     '{project_token}' をすべて置き換える。例: プロジェクト
--     'mycompany-prod-123' に r'-([^-]+)-' なら 'prod' になるので、
--     udf_name_suffix='_{project_token}' が '_prod' になる。
--     一致しなければ '' になり、残った '{project_token}' は下の ASSERT で落ちる。
--   system_name
--     このシステムを表す名前。関数もテーブルもビューも、この名前と '_' が
--     先頭に入る（既定なら viewlgc_analyze / viewlgc_t_diff_hist）。
--     同じプロジェクトに別のシステムを同居させたときに、どのオブジェクトが
--     どのシステムのものかを名前だけで見分けるためのもの。
--     **build_table.sql の同名の変数と必ず同じ値にすること。**
--     違う値だと関数が見つからない。英数字と '_' だけ（'-' は不可）。
--   udf_dataset
--     3 つの関数を作るデータセット。build_table.sql の同名の変数と合わせること。
--   udf_name_prefix / udf_name_suffix
--     関数名は udf_name_prefix + system_name + '_' + 基本名 + udf_name_suffix で
--     組み立てる。system_name は環境ではなくシステムを表すので、prefix とは別。
--     ルーチン名は英数字と '_' しか使えない（'-' は不可）ので、テーブル側の
--     prefix / suffix とは別に持つ。build_table.sql の同名の変数と合わせること。

-- [B] 既定のままで動くもの --------------------------------------------
-- 関数名（[C] で組み立てる）。基本名はリテラルで、変えるならここではなく
-- 下の SET を直す。build_table.sql の同名の変数と必ず同じ値にすること。
DECLARE udf_analyze_function_name  STRING;
DECLARE udf_render_function_name   STRING;
DECLARE udf_page_function_name     STRING;
DECLARE udf_markdown_function_name STRING;
DECLARE udf_css_function_name      STRING;
DECLARE udf_sql_function_name      STRING;

-- [C] 導出・内部用。編集しない ----------------------------------------
-- プロジェクトは自動検出した値を使う。別プロジェクトに作るときだけ
-- DEFAULT にリテラルを入れて固定する（COALESCE で非 NULL が勝つ）。
DECLARE default_project_id STRING;
DECLARE udf_project_id     STRING DEFAULT NULL;
DECLARE project_token      STRING;

-- 関数の本体（JavaScript）。ここは触らない。
-- SQL 文に直接埋めず変数に置くのは、本体を r\"\"\" \"\"\" で囲む必要があり、
-- それをさらに EXECUTE IMMEDIATE の文字列に入れ子にできないため。
-- 埋め込むときは TO_JSON_STRING で SQL の文字列リテラルに変換する
-- （JSON のエスケープは BigQuery の文字列リテラルと互換）。
DECLARE js_analyze STRING DEFAULT r"""
${analyzePack.code}
""";

DECLARE js_render STRING DEFAULT r"""
${renderPack.code}
""";

DECLARE js_page STRING DEFAULT r"""
${pagePack.code}
""";
DECLARE js_markdown STRING DEFAULT r"""
${markdownPack.code}
""";

DECLARE js_css STRING DEFAULT r"""
${cssPack.code}
""";

-- 実行中のプロジェクトを INFORMATION_SCHEMA.SCHEMATA から自動検出する
-- （catalog_name = ジョブが動いているプロジェクト）。リージョン修飾の
-- 識別子はパラメータにできないので @@location から組み立てる。
EXECUTE IMMEDIATE FORMAT(
  "SELECT DISTINCT catalog_name FROM \`region-%s\`.INFORMATION_SCHEMA.SCHEMATA LIMIT 1",
  @@location
) INTO default_project_id;
ASSERT default_project_id IS NOT NULL AS
  'プロジェクト ID を自動検出できません（このリージョンにデータセットが無い？）。udf_project_id にリテラルを入れて固定してください。';
SET udf_project_id = COALESCE(udf_project_id, default_project_id);

-- 名前を組み立てる前に '{project_token}' を置き換える。
SET project_token =
  COALESCE(REGEXP_EXTRACT(default_project_id, project_token_pattern), '');
SET udf_dataset     = REPLACE(udf_dataset,     '{project_token}', project_token);
SET udf_name_prefix = REPLACE(udf_name_prefix, '{project_token}', project_token);
SET udf_name_suffix = REPLACE(udf_name_suffix, '{project_token}', project_token);

ASSERT REGEXP_CONTAINS(udf_dataset, r'^[A-Za-z0-9_]+$') AS
  'udf_dataset は英数字と _ だけにしてください（置換されていない {project_token} が残っていませんか）。';

-- 関数名: udf_name_prefix + system_name + '_' + 基本名 + udf_name_suffix
ASSERT REGEXP_CONTAINS(system_name, r'^[A-Za-z0-9_]+$') AS
  'system_name は英数字と _ だけにしてください（ルーチン名に - は使えません）。';
SET udf_analyze_function_name =
  udf_name_prefix || system_name || '_' || 'analyze' || udf_name_suffix;
SET udf_render_function_name =
  udf_name_prefix || system_name || '_' || 'render' || udf_name_suffix;
SET udf_css_function_name =
  udf_name_prefix || system_name || '_' || 'group_css' || udf_name_suffix;
SET udf_page_function_name =
  udf_name_prefix || system_name || '_' || 'page' || udf_name_suffix;
SET udf_markdown_function_name =
  udf_name_prefix || system_name || '_' || 'markdown' || udf_name_suffix;
SET udf_sql_function_name =
  udf_name_prefix || system_name || '_' || 'render_dynamic_sql' || udf_name_suffix;
ASSERT REGEXP_CONTAINS(udf_analyze_function_name, r'^[A-Za-z0-9_]+$') AS
  'udf_analyze_function_name が不正です（ルーチン名に使えるのは英数字と _ だけ。- は不可）。';
ASSERT REGEXP_CONTAINS(udf_render_function_name, r'^[A-Za-z0-9_]+$') AS
  'udf_render_function_name が不正です（ルーチン名に使えるのは英数字と _ だけ。- は不可）。';
ASSERT REGEXP_CONTAINS(udf_page_function_name, r'^[A-Za-z0-9_]+$') AS
  'udf_page_function_name が不正です（ルーチン名に使えるのは英数字と _ だけ。- は不可）。';
ASSERT REGEXP_CONTAINS(udf_css_function_name, r'^[A-Za-z0-9_]+$') AS
  'udf_css_function_name が不正です（ルーチン名に使えるのは英数字と _ だけ。- は不可）。';
ASSERT REGEXP_CONTAINS(udf_markdown_function_name, r'^[A-Za-z0-9_]+$') AS
  'udf_markdown_function_name が不正です（ルーチン名に使えるのは英数字と _ だけ。- は不可）。';
ASSERT REGEXP_CONTAINS(udf_sql_function_name, r'^[A-Za-z0-9_]+$') AS
  'udf_sql_function_name が不正です（ルーチン名に使えるのは英数字と _ だけ。- は不可）。';


-- ---------------------------------------------------------------------
-- 1. viewlgc_analyze
--    base 1 件分の View 群を渡すと、解析結果を JSON で返す
--
-- 解析と描画を別の UDF に分けてある。インラインのコード ブロブは 1 個あたり
-- 32 KB までなので、1 本にまとめると枠が 1 つしか使えない。JS UDF の中から
-- 別の UDF は呼べないため、つなぐのは呼び出し側の SQL の仕事
-- （build_table.sql は analyze を 1 回呼び、その結果を render に渡す）。
--
-- 引数:
--   views         ARRAY<STRUCT<view_name STRING, ddl STRING>>
--                 同じ base を持つ View を全部渡す
--   options_json  NULL または '{}' で既定
--
-- 戻り値 STRING（JSON）:
--   viewCount      渡された View 数
--   groupCount     ロジックのグループ数（1 なら全部同一＝正常）
--   groupLabels    ["abjp, abuk, abus", …] タブ / ペイン見出し
--   groupSizes     各グループの View 数
--   suffixes       認識した suffix 一覧
--   unmatchedCount suffix を認識できなかった数
--   bases          描画に渡す本体。lead / tail は案内文
--   （メタデータは SQL 側で JSON_VALUE / JSON_VALUE_ARRAY で取り出す）
--
-- options_json のキー:
--   suffixParts   [["ab","cd","ef"],["jp","us","uk"]] のような区分の並び
--   suffixList    既知の suffix 一覧
--   suffixPattern 正規表現（既定は末尾の _ + 1〜6 文字）
--   substitutable 同一ロジックとみなす際に置換を許すトークン種別。
--                 既定 ["entity","number","string"]。置換してよいのは
--                 FROM / JOIN が指す実体名（entity）と値（number / string）
--                 だけ、という方針。列名・別名・CTE 名・ウィンドウ名・
--                 関数名は SQL の中で閉じた名前なので完全一致を要求する
--                 （横展開はコピーで行う運用なので、違えば書き換えの差）。
--                 値の差もロジック差として残したいなら ["entity"] にする。
--                 バッククォートの有無やパスの部分数は正規化しないので、
--                 意味が同じでも書き方が違えば別グループになる
--   suffixAware   比較の前に自分の suffix を伏せ字にする（既定 true）。
--                 リテラルに入った suffix でグループが割れるのを防ぐ
--   equivalentLiterals 同じグループとみなす文字列の組を 1 本の配列で並べる。
--                 ["suffix", ["aa","bb"], ["cc","dd"]]
--                 "suffix" は予約語で、その View 自身の suffix とその区分
--                 （abjp なら abjp / ab / jp）を表す。View ごとに中身が変わる
--                 ので値を並べて書けない。ほかの組は View に関係なく効く。
--                 1 つの配列が 1 つの同値類で、別の配列どうしは同一視しない
--                 （'aa' と 'cc' は別のまま）。照合は値の全体が一致したとき
--                 だけで、'x_aa_y' の aa は巻き込まない。大文字小文字は無視。
--                 文字列リテラルと数値リテラルが対象。
--   literalSuffixWords / literalGroups
--                 equivalentLiterals を書く前の旧い書き方。前者が "suffix"、
--                 後者が組の並びに当たる。equivalentLiterals を書くと
--                 そちらが一覧の唯一の定義になり、この 2 つは見ない
--   includeUnmatched suffix を認識できなかった View を単独の base として
--                 表示する（既定 true）。false で従来どおり除外
--   stripOptions  OPTIONS( … ) 句を落としてから比較する（既定 true）
--   layout        'auto'（既定・3 グループ以上はタブ）/ 'panes' / 'tabs'
--   mode          'inline'（既定）/ 'class'（CSS は group_css へ）/ 'embed'
--   fontSize / lineHeight / colors / diffLineOpacity / diffCharOpacity / syntax
-- ---------------------------------------------------------------------
EXECUTE IMMEDIATE FORMAT('''
CREATE OR REPLACE FUNCTION \`%s.%s.%s\`(
  views ARRAY<STRUCT<view_name STRING, ddl STRING>>,
  options_json STRING
)
RETURNS STRING
LANGUAGE js AS %s
''',
  udf_project_id, udf_dataset, udf_analyze_function_name,
  TO_JSON_STRING(js_analyze));


-- ---------------------------------------------------------------------
-- 2. viewlgc_render
--    viewlgc_analyze が返した JSON を受け取って比較 HTML にする
--
-- 解析はしない。options_json は analyze に渡したものと同じものを渡すこと
-- （mode / layout / 色の指定はこちらで効く）。
-- ---------------------------------------------------------------------
EXECUTE IMMEDIATE FORMAT('''
CREATE OR REPLACE FUNCTION \`%s.%s.%s\`(
  analysis_json STRING,
  options_json STRING
)
RETURNS STRING
LANGUAGE js AS %s
''',
  udf_project_id, udf_dataset, udf_render_function_name,
  TO_JSON_STRING(js_render));


-- ---------------------------------------------------------------------
-- 3. viewlgc_page
--    参照関係の図を作り、渡された差分 HTML と外側タブで束ねて 1 枚にする
--
-- 差分は作らない。viewlgc_render の出力をそのまま受け取って包むだけ。
-- 図の解析にはトークナイザが要るので、差分側とは別の UDF にしてある
-- （両方を 1 つに積むとインラインの 32 KB に収まらない）。
-- ---------------------------------------------------------------------
EXECUTE IMMEDIATE FORMAT('''
CREATE OR REPLACE FUNCTION \`%s.%s.%s\`(
  analysis_json STRING,
  diff_html STRING,
  options_json STRING
)
RETURNS STRING
LANGUAGE js AS %s
''',
  udf_project_id, udf_dataset, udf_page_function_name,
  TO_JSON_STRING(js_page));


-- ---------------------------------------------------------------------
-- 4. viewlgc_markdown
--    base ごとのメモ（Markdown）を HTML にする
--
-- これだけはビューの中から呼ぶ（＝レポートを開くたびに走る）。事前生成の
-- テーブルに焼き込むと、メモを直しても次の日次実行まで古いままになるため。
-- Markdown は 1 件が数 KB なので、クエリのたびに変換しても実行時間に響かない。
--
-- 生の HTML は通さない（必ずエスケープする）。画像も読み込まない。
-- 出す markup のクラスは viewlgc_group_css の CSS と 1 対 1 で対応する。
-- ---------------------------------------------------------------------
EXECUTE IMMEDIATE FORMAT('''
CREATE OR REPLACE FUNCTION \`%s.%s.%s\`(md STRING)
RETURNS STRING
LANGUAGE js AS %s
''',
  udf_project_id, udf_dataset, udf_markdown_function_name,
  TO_JSON_STRING(js_markdown));


-- ---------------------------------------------------------------------
-- 5. viewlgc_group_css
--    mode='class' のときテンプレートへ貼る CSS を返す
--
--   SELECT \`<project>.<udf_dataset>.viewlgc_group_css\`(NULL);
--
-- 結果を <style> … </style> で囲んで Templated Record のテンプレートに貼る。
-- 見出し・タブ・パラメータ表の規則と、差分表の規則の両方を含む。
-- タブの CSS は ID ではなくクラスで書いてあるので、レコードが変わっても
-- この CSS のまま使える。
--
-- options_json は group_info と同じものを渡すこと。色やフォントを
-- 変えた場合、CSS 側も同じ設定で作り直す必要がある。
-- ---------------------------------------------------------------------
EXECUTE IMMEDIATE FORMAT('''
CREATE OR REPLACE FUNCTION \`%s.%s.%s\`(options_json STRING)
RETURNS STRING
LANGUAGE js AS %s
''',
  udf_project_id, udf_dataset, udf_css_function_name,
  TO_JSON_STRING(js_css));


-- ---------------------------------------------------------------------
-- 6. viewlgc_render_dynamic_sql
--    build_table.sql の SQL テンプレートに含まれる __…__ を展開する
--
-- BigQuery は識別子（プロジェクト・データセット・テーブル・関数名）を
-- クエリ パラメータにできない。@param が使えるのは値だけ。そこで
-- テンプレートの目印をこの関数で置き換えてから EXECUTE IMMEDIATE する。
--
-- 永続関数にしてあるのは、スクリプトの TEMP FUNCTION を 1 つでも置くと
-- その DDL が子ジョブすべてのクエリ本文に前置され、コンソールの結果一覧が
-- どれも TEMP FUNCTION の DDL に見えてしまうため（CREATE VIEW も通らない）。
--
-- 置き換える目印:
--   __TARGET_PROJECT__     読み取り対象のプロジェクト
--   __JOB_REGION__         region- を除いたロケーション
--   __T_DIFF_HIST__        履歴テーブル（project.dataset.table）
--   __T_BASE_NOTE__        base ごとのメモの外部テーブル（同上）
--   __V_DIFF__             最新スナップショットのビュー（基準 = 先頭グループ）
--   __V_DIFF_BY_REF__      同上。基準ごとに 1 行あるほう
--   __UDF_ANALYZE__        analyze 関数（project.dataset.function）
--   __UDF_RENDER__         render 関数（同上）
--   __UDF_PAGE__           page 関数（同上）
--   __UDF_MARKDOWN__       markdown 関数（同上）
--   __UDF_CSS__            group_css 関数（同上）
--   __TZ__                 snapshot_date の基準タイムゾーン
--   __RETENTION_DAYS__     パーティションの保持日数
--   __SUFFIX_PATTERN__     suffix を切り出す正規表現
--   __NOTE_SHEET_URL__     メモのスプレッドシートの URL
--   __NOTE_SHEET_RANGE__   その中の読み取り範囲
--   __SCHEMA_COND__        SCHEMATA 用の絞り込み条件（SQL 片）
--   __VIEW_DATASET_COND__  VIEWS 用のデータセット条件（SQL 片）
--   __VIEW_NAME_COND__     VIEWS 用の View 名条件（SQL 片）
--
-- 中身が SQL になるもの（__*_COND__）を最後に置くのは、置き換えた中身が
-- さらに走査されないようにするため。
-- ---------------------------------------------------------------------
EXECUTE IMMEDIATE FORMAT('''
CREATE OR REPLACE FUNCTION \`%s.%s.%s\`(
  sql_template STRING,
  work_project_id STRING,
  work_dataset STRING,
  udf_project_id STRING,
  udf_dataset STRING,
  target_project_id STRING,
  job_region STRING,
  objects STRUCT<
    diff_hist         STRING,
    diff_latest       STRING,
    diff_by_ref       STRING,
    base_note         STRING,
    analyze_function  STRING,
    render_function   STRING,
    page_function     STRING,
    markdown_function STRING,
    css_function      STRING
  >,
  options STRUCT<
    time_zone        STRING,
    retention_days   STRING,
    suffix_pattern   STRING,
    note_sheet_url   STRING,
    note_sheet_range STRING
  >,
  conditions STRUCT<
    schema_condition       STRING,
    view_dataset_condition STRING,
    view_name_condition    STRING
  >
)
RETURNS STRING
AS (
  REPLACE(
  REPLACE(
  REPLACE(
  REPLACE(
  REPLACE(
  REPLACE(
  REPLACE(
  REPLACE(
  REPLACE(
  REPLACE(
  REPLACE(
  REPLACE(
  REPLACE(
  REPLACE(
  REPLACE(
  REPLACE(
  REPLACE(
  REPLACE(
  REPLACE(
    sql_template,
    '__TARGET_PROJECT__', target_project_id),
    '__JOB_REGION__', job_region),
    '__T_DIFF_HIST__',
      work_project_id || '.' || work_dataset || '.' || objects.diff_hist),
    '__T_BASE_NOTE__',
      work_project_id || '.' || work_dataset || '.' || objects.base_note),
    '__V_DIFF_BY_REF__',
      work_project_id || '.' || work_dataset || '.' || objects.diff_by_ref),
    '__V_DIFF__',
      work_project_id || '.' || work_dataset || '.' || objects.diff_latest),
    '__UDF_ANALYZE__',
      udf_project_id || '.' || udf_dataset || '.' || objects.analyze_function),
    '__UDF_RENDER__',
      udf_project_id || '.' || udf_dataset || '.' || objects.render_function),
    '__UDF_PAGE__',
      udf_project_id || '.' || udf_dataset || '.' || objects.page_function),
    '__UDF_MARKDOWN__',
      udf_project_id || '.' || udf_dataset || '.' || objects.markdown_function),
    '__UDF_CSS__',
      udf_project_id || '.' || udf_dataset || '.' || objects.css_function),
    '__TZ__', options.time_zone),
    '__RETENTION_DAYS__', options.retention_days),
    '__SUFFIX_PATTERN__', options.suffix_pattern),
    '__NOTE_SHEET_URL__', options.note_sheet_url),
    '__NOTE_SHEET_RANGE__', options.note_sheet_range),
    '__SCHEMA_COND__', conditions.schema_condition),
    '__VIEW_DATASET_COND__', conditions.view_dataset_condition),
    '__VIEW_NAME_COND__', conditions.view_name_condition)
)
''',
  udf_project_id, udf_dataset, udf_sql_function_name);


-- 作った 6 つの名前を出す。build_table.sql に同じ値を入れる。
SELECT
  FORMAT('%s.%s.%s', udf_project_id, udf_dataset, udf_analyze_function_name)  AS analyze_function,
  FORMAT('%s.%s.%s', udf_project_id, udf_dataset, udf_render_function_name)   AS render_function,
  FORMAT('%s.%s.%s', udf_project_id, udf_dataset, udf_page_function_name)     AS page_function,
  FORMAT('%s.%s.%s', udf_project_id, udf_dataset, udf_markdown_function_name) AS markdown_function,
  FORMAT('%s.%s.%s', udf_project_id, udf_dataset, udf_css_function_name)      AS css_function,
  FORMAT('%s.%s.%s', udf_project_id, udf_dataset, udf_sql_function_name)      AS sql_function,
  CURRENT_TIMESTAMP() AS created_at;
END;
`;

// 生成物の検証。r""" """ の中に """ が現れると文字列がそこで切れる。
{
  const opens = (sql.match(/r"""/g) || []).length;
  const triples = (sql.match(/"""/g) || []).length;
  if (triples !== opens * 2) {
    console.log(`  FAIL  三重引用符の数が合いません（開始 ${opens} 個に対して ${triples} 個）`);
    process.exit(1);
  }
  // 埋め込んだ JS が本物か。上の JS 検証は pack の .code を直接評価するので、
  // SQL に埋めるときに .code を書き忘れて '[object Object]' が入っても
  // 素通りしてしまう。BigQuery まで持っていって初めて JS の構文エラーになる。
  const marker = 'DECLARE (js_[a-z_]+) STRING DEFAULT r' + '"'.repeat(3) + '\\n';
  const blobs = [...sql.matchAll(
    new RegExp(marker + '([\\s\\S]*?)\\n' + '"'.repeat(3), 'g'))];
  if (blobs.length !== 5) {
    console.log(`  FAIL  埋め込んだ JS が 5 つ見つかりません（${blobs.length} 個）`);
    process.exit(1);
  }
  for (const [, name, code] of blobs) {
    if (!code.includes('function ') || code.length < 1000) {
      console.log(`  FAIL  ${name} の中身が JS になっていません: ${code.slice(0, 40)}`);
      process.exit(1);
    }
  }
  console.log('  PASS  埋め込んだ JS が 5 つとも本物');

  // FORMAT のテンプレートに素の % があると書式指定と解釈される。
  // 引数側（JS 本体）の % は無関係なので、''' … ''' の中だけを見る。
  const templates = [...sql.matchAll(/FORMAT\('''([\s\S]*?)'''/g)].map((m) => m[1]);
  if (templates.length !== 6) {
    console.log(`  FAIL  FORMAT のテンプレートが 6 つ見つかりません（${templates.length} 個）`);
    process.exit(1);
  }
  for (const t of templates) {
    const bad = t.match(/%(?![s])/);
    if (bad) {
      console.log(`  FAIL  FORMAT テンプレートに %s 以外の % があります: ${bad[0]}`);
      process.exit(1);
    }
  }
  const stale = sql.match(/@@[A-Z_]+@@/);
  if (stale) {
    console.log(`  FAIL  旧いプレースホルダが残っています: ${stale[0]}`);
    process.exit(1);
  }
  console.log('\n  PASS  DDL は FORMAT の書式で組み立て（% は %s のみ）');
}

const outPath = join(here, 'view_group_html.sql');
await writeFile(outPath, sql);
console.log(`\nwrote ${outPath} (${kb(Buffer.byteLength(sql))})`);

// テンプレートに貼る CSS も書き出しておく。中身は
// SELECT viewlgc_group_css(...) の出力そのものなので、BigQuery を叩かずに
// 貼り付けたいときはこのファイルを使える（内容は同じ）。
const cssPath = join(here, 'template_style.html');
await writeFile(cssPath,
  `<!--
  Templated Record のテンプレートに貼る CSS（mode='class' のとき）。
  中身は SELECT \`<project>.<udf_dataset>.viewlgc_group_css\`(...) の出力そのもの。
  このファイルは build_udf.mjs が生成する。直接編集しないこと。

  ここは固定。差分の内容が変わっても書き換え不要。
  この下にフィールド（diff_html）を差し込む。

  注意: templated_record/samples/04_template_style.html とは別物。
  あちらは DIFF_CSS の出力で、見出し・タブ・パラメータ表の .vg-* 規則を
  含まないため、こちらの表示には使えない（タブが動かない）。
-->
<style>
${css}
</style>
`);
console.log(`wrote ${cssPath} (${kb(Buffer.byteLength(css))} の CSS)`);
