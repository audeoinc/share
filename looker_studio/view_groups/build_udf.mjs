// suffix 違い View のロジック グループ比較を BigQuery の JS UDF にする。
//
//   node build_udf.mjs          -> view_group_html.sql を生成
//   node build_udf.mjs --check  -> 生成せず、Node 上で UDF 本体を実行して検証だけ
//
// 生成するのは 2 つ:
//   VIEW_GROUP_HTML(views ARRAY<STRUCT<view_name STRING, ddl STRING>>, options_json STRING)
//   VIEW_GROUP_CSS(options_json STRING)
//
// サイズについて:
//   BigQuery の UDF はインラインのコード ブロブに上限があり、レガシー SQL の
//   ドキュメントには 32 KB と明記されている（標準 SQL の永続 UDF に同じ値が
//   効くかは確認できていない）。素の連結は 45 KB あって上限をまたぐため、
//   esbuild で最小化してから埋め込む。生成時に閾値を超えたら失敗させて、
//   BigQuery に弾かれるものを出荷しないようにしている。
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

// インラインで埋め込んでよい上限。32 KB に対して余裕を持たせる。
const SIZE_LIMIT = 30 * 1024;

const SOURCES = [
  ['lib/diff.js', join(here, '..', 'ddl_diff_viz', 'src', 'lib', 'diff.js')],
  ['lib/render.js', join(here, '..', 'ddl_diff_viz', 'src', 'lib', 'render.js')],
  ['analyze.js', join(here, 'analyze.js')],
  ['render_groups.js', join(here, 'render_groups.js')],
];

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

const libs = [];
for (const [name, path] of SOURCES) {
  libs.push(strip(await readFile(path, 'utf8'), name));
}
const libSrc = libs.join('\n\n');

// --- 共通ヘルパ（DIFF_HTML と同じ考え方） ------------------------------
const shared = `
function __opts(options_json) {
  if (!options_json) return {};
  try { return JSON.parse(options_json) || {}; } catch (e) { return {}; }
}

function __notice(text) {
  return '<div class="vg-notice">' + String(text).replace(/[<>&]/g, '') + '</div>';
}

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

// --- VIEW_GROUP_HTML のドライバ ----------------------------------------
const htmlDriver = `
function __run(views, options_json) {
  var opts = __opts(options_json);
  if (!views || views.length === 0) return __notice('View が渡されていません。');

  var rows = [];
  for (var i = 0; i < views.length; i++) {
    var v = views[i];
    if (!v) continue;
    rows.push({ view_name: v.view_name, ddl: v.ddl });
  }

  var res = analyze(rows, opts);
  if (res.bases.length === 0) {
    return __notice(
      views.length + ' 件すべて suffix を認識できませんでした。' +
      'suffixParts / suffixList / suffixPattern の指定を確認してください。');
  }

  // 呼び出し側で base ごとに束ねている前提だが、混ざっていても全部描く
  var html = '';
  for (var b = 0; b < res.bases.length; b++) html += renderBase(res.bases[b], opts);
  if (res.unmatched.length > 0) {
    html += __notice('suffix を認識できなかった View が ' + res.unmatched.length + ' 件あります。');
  }
  return __applyMode(html, opts.mode || 'inline');
}

return __run(views, options_json);
`.trim();

// --- VIEW_GROUP_CSS のドライバ -----------------------------------------
// 全パターンを描画して、そこに出る規則を集める。markup と同じコードから作るので
// クラス名が食い違わない。chromeCss() はもともとクラス方式なのでそのまま足す。
const cssDriver = `
function __fixtureRules(opts) {
  var rules = {};
  function collect(rows) {
    var res = analyze(rows, opts);
    for (var b = 0; b < res.bases.length; b++) {
      var r = __split(renderBase(res.bases[b], opts)).rules;
      for (var k in r) rules[k] = r[k];
    }
  }
  function mk(suffix, sql) { return { view_name: 'v_fixture_' + suffix, ddl: sql }; }

  var A = 'SELECT\\n  a,\\n  b\\nFROM t_SUF\\nWHERE x = 1';
  var B = 'SELECT\\n  a,\\n  c.b\\nFROM t_SUF\\nLEFT JOIN u_SUF AS c USING (a)\\nWHERE x = 1';
  var C = 'SELECT\\n  a\\nFROM t_SUF\\nWHERE x = 1';
  var D = 'SELECT\\n  a,\\n  b,\\n  d\\nFROM t_SUF\\nWHERE x = 1';
  function s(t, suf) { return t.replace(/SUF/g, suf); }

  // 1 グループ（差分なし）
  collect([mk('abjp', s(A, 'abjp')), mk('abus', s(A, 'abus'))]);
  // 2 グループ（2 ペイン）
  collect([mk('abjp', s(A, 'abjp')), mk('cdjp', s(B, 'cdjp'))]);
  // 3 グループ以上（タブ）
  collect([mk('abjp', s(A, 'abjp')), mk('cdjp', s(B, 'cdjp')),
           mk('efjp', s(C, 'efjp')), mk('ghjp', s(D, 'ghjp'))]);
  // 3 ペイン横並び（layout:'panes'）
  var p = {}; for (var k in opts) p[k] = opts[k];
  p.layout = 'panes';
  var saved = opts; opts = p;
  collect([mk('abjp', s(A, 'abjp')), mk('cdjp', s(B, 'cdjp')), mk('efjp', s(C, 'efjp'))]);
  opts = saved;

  return rules;
}

var __o = __opts(options_json);
if (!__o.suffixParts && !__o.suffixList && !__o.suffixPattern) {
  // fixture の View 名が割れるよう、既定を与える
  __o.suffixParts = [['ab', 'cd', 'ef', 'gh'], ['jp', 'us', 'uk']];
}
return chromeCss() + '\\n' + __rulesToCss(__fixtureRules(__o));
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

function pack(driver, label) {
  const raw = [libSrc, '', shared, '', driver].join('\n');
  if (!esbuild) return { code: raw, raw: raw.length, min: null, label };
  // format を指定するとラップされて未使用の関数が落ちるので、指定しない
  const code = esbuild.transformSync(raw, { loader: 'js', minify: true, target: 'es2017' }).code;
  return { code, raw: raw.length, min: code.length, label };
}

const htmlPack = pack(htmlDriver, 'VIEW_GROUP_HTML');
const cssPack = pack(cssDriver, 'VIEW_GROUP_CSS');

// --- 検証: 最小化した本体をそのまま実行する -----------------------------
const S = require(join(here, 'sample_views.js'));
const VIEW_GROUP_HTML = new Function('views', 'options_json', htmlPack.code);
const VIEW_GROUP_CSS = new Function('options_json', cssPack.code);

const views = S.sampleRows().map((r) => ({ view_name: r.view_name, ddl: r.ddl }));
const OPTS = JSON.stringify({ suffixParts: S.SUFFIX_PARTS });
const html = VIEW_GROUP_HTML(views, OPTS);
const classed = VIEW_GROUP_HTML(views, JSON.stringify({ suffixParts: S.SUFFIX_PARTS, mode: 'class' }));
const embed = VIEW_GROUP_HTML(views, JSON.stringify({ suffixParts: S.SUFFIX_PARTS, mode: 'embed' }));
const css = VIEW_GROUP_CSS(JSON.stringify({ suffixParts: S.SUFFIX_PARTS }));

const text = html.replace(/<[^>]*>/g, '');
const used = [...new Set([...classed.matchAll(/class="(d[0-9a-z]+)"/g)].map((m) => m[1]))];
const defined = new Set([...css.matchAll(/^\.(d[0-9a-z]+)\{/gm)].map((m) => m[1]));

const checks = [
  ['最小化後も動く（HTML を生成）', html.includes('vg-root')],
  ['タイトルが base 名', text.includes('v_daily_sales')],
  ['3 グループでタブになる', html.includes('vg-tablist')],
  ['ペイン見出しに suffix が列記される', text.includes('abjp, abuk, abus')],
  ['パラメータ一覧が付く', text.includes('パラメータ化した箇所')],
  ['class モードは style 属性を残さない', !/ style="/.test(classed)],
  ['VIEW_GROUP_CSS が markup の全クラスを網羅', used.every((c) => defined.has(c))],
  ['VIEW_GROUP_CSS に chrome の規則が入る', css.includes('.vg-tablist') && css.includes('.vg-r1:checked')],
  ['embed モードは style ブロックを含む', embed.includes('<style>') && embed.includes('.vg-panel')],
  ['空入力で案内を返す', VIEW_GROUP_HTML([], OPTS).includes('View が渡されていません')],
  ['suffix 不一致で案内を返す',
    VIEW_GROUP_HTML([{ view_name: 'no_suffix_here', ddl: 'SELECT 1' }], OPTS)
      .includes('suffix を認識できませんでした')],
  ['壊れた options_json でも落ちない',
    typeof VIEW_GROUP_HTML(views, '{ broken') === 'string'],
  ['script タグを含まない', !/<script/i.test(html)],
];

// サイズ検証
for (const p of [htmlPack, cssPack]) {
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
console.log('UDF 本体のサイズ（インライン上限 32 KB に対して）');
for (const p of [htmlPack, cssPack]) {
  console.log(`  ${p.label.padEnd(17)} 素 ${kb(p.raw).padStart(8)} → ` +
    (p.min === null ? '最小化なし' : `最小化 ${kb(p.min).padStart(8)}`) +
    `  （上限比 ${(Buffer.byteLength(p.code) / SIZE_LIMIT * 100).toFixed(0)}%）`);
}
console.log(`\n出力 HTML: inline ${kb(Buffer.byteLength(html))} / ` +
  `class ${kb(Buffer.byteLength(classed))} / CSS ${kb(Buffer.byteLength(css))}`);

if (failed > 0) process.exit(1);
if (process.argv.includes('--check')) process.exit(0);

// --- SQL を書き出す ----------------------------------------------------
const sql = `-- =====================================================================
-- suffix 違い View のロジック グループ比較を HTML で返す BigQuery UDF
--
-- ※ このファイルは build_udf.mjs が生成する。直接編集しないこと。
--    再生成: node looker_studio/view_groups/build_udf.mjs
--    本体は esbuild で最小化してある（インラインのコード ブロブは
--    32 KB が上限とされているため。素の連結は約 45 KB で上限をまたぐ）。
--
-- PROJECT / DATASET は自分の環境に置換すること。
-- =====================================================================


-- ---------------------------------------------------------------------
-- VIEW_GROUP_HTML — base 1 件分の View 群を渡すと比較 HTML を返す
--
-- 引数:
--   views         ARRAY<STRUCT<view_name STRING, ddl STRING>>
--                 同じ base を持つ View を全部渡す
--   options_json  NULL または '{}' で既定
--
-- options_json のキー:
--   suffixParts   [["ab","cd","ef"],["jp","us","uk"]] のような区分の並び
--   suffixList    既知の suffix 一覧
--   suffixPattern 正規表現（既定は末尾の _ + 1〜6 文字）
--   substitutable 同一ロジックとみなす際に置換を許すトークン種別
--                 既定 ["ident","quoted"]。リテラル差も無視するなら
--                 ["ident","quoted","number","string"]
--   layout        'auto'（既定・3 グループ以上はタブ）/ 'panes' / 'tabs'
--   mode          'inline'（既定）/ 'class'（CSS は VIEW_GROUP_CSS へ）/ 'embed'
--   fontSize / lineHeight / colors / diffLineOpacity / diffCharOpacity / syntax
--
-- 例:
--   VIEW_GROUP_HTML(
--     ARRAY_AGG(STRUCT(view_name, ddl) ORDER BY view_name),
--     '{"suffixParts":[["ab","cd","ef"],["jp","us","uk"]],"mode":"class"}')
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION \`PROJECT.DATASET.VIEW_GROUP_HTML\`(
  views ARRAY<STRUCT<view_name STRING, ddl STRING>>,
  options_json STRING
)
RETURNS STRING
LANGUAGE js AS r"""
${htmlPack.code}
""";


-- ---------------------------------------------------------------------
-- VIEW_GROUP_CSS — mode='class' のときテンプレートへ貼る CSS を返す
--
--   SELECT \`PROJECT.DATASET.VIEW_GROUP_CSS\`(NULL);
--
-- 結果を <style> … </style> で囲んで Templated Record のテンプレートに貼る。
-- 見出し・タブ・パラメータ表の規則と、差分表の規則の両方を含む。
-- タブの CSS は ID ではなくクラスで書いてあるので、レコードが変わっても
-- この CSS のまま使える。
--
-- options_json は VIEW_GROUP_HTML と同じものを渡すこと。色やフォントを
-- 変えた場合、CSS 側も同じ設定で作り直す必要がある。
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION \`PROJECT.DATASET.VIEW_GROUP_CSS\`(options_json STRING)
RETURNS STRING
LANGUAGE js AS r"""
${cssPack.code}
""";
`;

const outPath = join(here, 'view_group_html.sql');
await writeFile(outPath, sql);
console.log(`\nwrote ${outPath} (${kb(Buffer.byteLength(sql))})`);
