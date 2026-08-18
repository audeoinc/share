// suffix 違い View のロジック グループ比較を BigQuery の JS UDF にする。
//
//   node build_udf.mjs          -> view_group_html.sql を生成
//   node build_udf.mjs --check  -> 生成せず、Node 上で UDF 本体を実行して検証だけ
//
// 生成するのは 2 つ:
//   VIEW_GROUP_INFO(views ARRAY<STRUCT<view_name STRING, ddl STRING>>, options_json STRING)
//     -> STRUCT<view_count, group_count, group_labels, group_sizes, suffixes,
//               unmatched_count, html>
//   VIEW_GROUP_CSS(options_json STRING)
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

// インラインで埋め込んでよい上限。32 KB に対して余裕を持たせる。
const SIZE_LIMIT = 30 * 1024;

const SOURCES = [
  ['lib/diff.js', join(here, '..', 'ddl_diff_viz', 'src', 'lib', 'diff.js')],
  ['lib/render.js', join(here, '..', 'ddl_diff_viz', 'src', 'lib', 'render.js')],
  ['analyze.js', join(here, 'analyze.js')],
  ['render_groups.js', join(here, 'render_groups.js')],
];

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
const UNUSED = ['renderFragment3', 'build3Way', 'mapToBase', 'baseCell', 'segsText'];

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
const libSrc = dropFunctions(libs.join('\n\n'), UNUSED);

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

// --- VIEW_GROUP_INFO のドライバ ----------------------------------------
const infoDriver = `
function __empty(msg) {
  return {
    view_count: 0, group_count: 0, group_labels: [], group_sizes: [],
    suffixes: [], unmatched_count: 0, html: __notice(msg)
  };
}

function __run(views, options_json) {
  var opts = __opts(options_json);
  if (!views || views.length === 0) return __empty('View が渡されていません。');

  var rows = [];
  for (var i = 0; i < views.length; i++) {
    if (views[i]) rows.push({ view_name: views[i].view_name, ddl: views[i].ddl });
  }

  var res = analyze(rows, opts);
  if (res.bases.length === 0) {
    var e = __empty(rows.length + ' 件すべて suffix を認識できませんでした。' +
      'suffixParts / suffixList / suffixPattern の指定を確認してください。');
    e.unmatched_count = res.unmatched.length;
    return e;
  }

  // 呼び出し側で base ごとに束ねている前提。混ざっていても全部描く。
  var html = '';
  var labels = [];
  var sizes = [];
  var sufs = [];
  var viewCount = 0;
  var groupCount = 0;
  for (var b = 0; b < res.bases.length; b++) {
    var bs = res.bases[b];
    html += renderBase(bs, opts);
    viewCount += bs.viewCount;
    groupCount += bs.groupCount;
    for (var g = 0; g < bs.groups.length; g++) {
      labels.push(bs.groups[g].suffixes.join(', '));
      sizes.push(bs.groups[g].members.length);
      for (var k = 0; k < bs.groups[g].suffixes.length; k++) sufs.push(bs.groups[g].suffixes[k]);
    }
  }
  if (res.unmatched.length > 0) {
    html += __notice('suffix を認識できなかった View が ' + res.unmatched.length + ' 件あります。');
  }

  return {
    view_count: viewCount,
    group_count: groupCount,
    group_labels: labels,
    group_sizes: sizes,
    suffixes: sufs.sort(),
    unmatched_count: res.unmatched.length,
    html: __applyMode(html, opts.mode || 'inline')
  };
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

const infoPack = pack(infoDriver, 'VIEW_GROUP_INFO');
const cssPack = pack(cssDriver, 'VIEW_GROUP_CSS');

// --- 検証: 最小化した本体をそのまま実行する -----------------------------
const S = require(join(here, 'sample_views.js'));
const VIEW_GROUP_INFO = new Function('views', 'options_json', infoPack.code);
const VIEW_GROUP_CSS = new Function('options_json', cssPack.code);

const views = S.sampleRows().map((r) => ({ view_name: r.view_name, ddl: r.ddl }));
const OPTS = JSON.stringify({ suffixParts: S.SUFFIX_PARTS });
const info = VIEW_GROUP_INFO(views, OPTS);
const html = info.html;
const classed = VIEW_GROUP_INFO(views, JSON.stringify({ suffixParts: S.SUFFIX_PARTS, mode: 'class' })).html;
const embed = VIEW_GROUP_INFO(views, JSON.stringify({ suffixParts: S.SUFFIX_PARTS, mode: 'embed' })).html;
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
  ['メタデータ: View 数', info.view_count === 9],
  ['メタデータ: グループ数', info.group_count === 3],
  ['メタデータ: グループ ラベル',
    info.group_labels.join(' | ') === 'abjp, abuk, abus | cdjp, cduk, cdus | efjp, efuk, efus'],
  ['メタデータ: グループの規模', info.group_sizes.join(',') === '3,3,3'],
  ['メタデータ: suffix 一覧', info.suffixes.length === 9 && info.suffixes[0] === 'abjp'],
  ['メタデータ: 未認識は 0', info.unmatched_count === 0],
  ['空入力で案内を返す',
    VIEW_GROUP_INFO([], OPTS).html.includes('View が渡されていません')],
  ['suffix 不一致で案内を返す',
    VIEW_GROUP_INFO([{ view_name: 'no_suffix_here', ddl: 'SELECT 1' }], OPTS)
      .html.includes('suffix を認識できませんでした')],
  ['壊れた options_json でも落ちない',
    typeof VIEW_GROUP_INFO(views, '{ broken').html === 'string'],
  ['script タグを含まない', !/<script/i.test(html)],
];

// サイズ検証
for (const p of [infoPack, cssPack]) {
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
for (const p of [infoPack, cssPack]) {
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
--    32 KB までに制限されるため。素の連結は約 45 KB で確実に弾かれる）。
--
-- PROJECT / DATASET は自分の環境に置換すること。
-- =====================================================================


-- ---------------------------------------------------------------------
-- VIEW_GROUP_INFO — base 1 件分の View 群を渡すと、比較 HTML とメタデータを返す
--
-- 引数:
--   views         ARRAY<STRUCT<view_name STRING, ddl STRING>>
--                 同じ base を持つ View を全部渡す
--   options_json  NULL または '{}' で既定
--
-- 戻り値 STRUCT:
--   view_count       FLOAT64        渡された View 数
--   group_count      FLOAT64        ロジックのグループ数（1 なら全部同一＝正常）
--   group_labels     ARRAY<STRING>  ["abjp, abuk, abus", …] ペイン見出し
--   group_sizes      ARRAY<FLOAT64> 各グループの View 数
--   suffixes         ARRAY<STRING>  認識した suffix 一覧
--   unmatched_count  FLOAT64        suffix を認識できなかった数
--   html             STRING         比較 HTML
--   （数値が FLOAT64 なのは JS UDF が INT64 を扱えないため。SQL 側で CAST する）
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
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION \`PROJECT.DATASET.VIEW_GROUP_INFO\`(
  views ARRAY<STRUCT<view_name STRING, ddl STRING>>,
  options_json STRING
)
RETURNS STRUCT<
  view_count      FLOAT64,
  group_count     FLOAT64,
  group_labels    ARRAY<STRING>,
  group_sizes     ARRAY<FLOAT64>,
  suffixes        ARRAY<STRING>,
  unmatched_count FLOAT64,
  html            STRING
>
LANGUAGE js AS r"""
${infoPack.code}
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

// テンプレートに貼る CSS も書き出しておく。中身は
// SELECT VIEW_GROUP_CSS(...) の出力そのものなので、BigQuery を叩かずに
// 貼り付けたいときはこのファイルを使える（内容は同じ）。
const cssPath = join(here, 'template_style.html');
await writeFile(cssPath,
  `<!--
  Templated Record のテンプレートに貼る CSS（mode='class' のとき）。
  中身は SELECT \`PROJECT.DATASET.VIEW_GROUP_CSS\`(...) の出力そのもの。
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
