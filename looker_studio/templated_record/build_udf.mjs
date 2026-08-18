// diff_html/ の拡張の lib/ から、BigQuery の JS UDF を生成する。
//
//   node build_udf.mjs          -> ddl_diff_html.sql を生成
//   node build_udf.mjs --check  -> 生成せず、Node 上で UDF 本体を実行して検証だけ
//
// 生成するのは 2 つ:
//   DIFF_HTML(before, after, left_label, right_label, options_json)
//   DIFF_CSS(options_json)   … class モードでテンプレートに貼る CSS
//
// 24KB の JS を手でコピーすると拡張側の更新に追従できないので、生成にしている。
// lib/ の実体は ../ddl_diff_viz/src/lib/（ベンダリング済みの 1 箇所）を参照する。
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const libDir = join(here, '..', 'ddl_diff_viz', 'src', 'lib');

/** CommonJS の体裁（'use strict' / require / module.exports）を落として素の関数群にする。 */
function strip(src, file) {
  const out = src
    .replace(/^'use strict';\s*$/m, '')
    .replace(/^const\s*\{[^}]*\}\s*=\s*require\([^)]*\);\s*$/m, '')
    .replace(/^module\.exports\s*=[^;]*;\s*$/m, '');
  if (/\brequire\s*\(/.test(out) || /\bmodule\.exports\b/.test(out)) {
    throw new Error(`${file}: require / module.exports が残っています`);
  }
  if (out.includes('"""')) {
    throw new Error(`${file}: 三重引用符が含まれており raw string を壊します`);
  }
  return out.trim();
}

const diffJs = strip(await readFile(join(libDir, 'diff.js'), 'utf8'), 'diff.js');
const renderJs = strip(await readFile(join(libDir, 'render.js'), 'utf8'), 'render.js');

// 両方の UDF が共有するヘルパ。
const shared = `
/* ------------------------------------------------------------------
 * ここから下は BigQuery UDF 用（build_udf.mjs が付加）
 * ------------------------------------------------------------------ */

function __opts(options_json) {
  if (!options_json) return {};
  try { return JSON.parse(options_json) || {}; } catch (e) { return {}; }
}

function __notice(text) {
  return '<div style="padding:8px 12px;border:1px solid #D0D7DE;border-left:4px solid #D0D7DE;' +
    'border-radius:4px;background:#F6F8FA;color:#57606A;' +
    "font:13px/1.6 'Roboto','Segoe UI',system-ui,sans-serif\\">" +
    String(text).replace(/[<>&]/g, '') + '</div>';
}

/* FNV-1a → base36。クラス名を style 属性の中身だけから決めるので、
   差分の内容や出現順が変わっても同じ宣言には必ず同じクラス名が付く。
   これがないとテンプレート側の固定 CSS と markup 側のクラス名がズレる。 */
function __hashClass(s) {
  var h = 0x811c9dc5;
  for (var i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return 'd' + h.toString(36);
}

/* インライン CSS の HTML を「class 付き markup」と「CSS 規則」に分解する。 */
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
`.trim();

// DIFF_HTML 用のドライバ。
const htmlDriver = `
/**
 * 変更行の前後 contextLines 行だけ残す（GitHub の折りたたみ相当）。
 * 行番号は各行が自分で持っているので、間引いても番号はズレない。
 * 省略箇所の「…」は出さない（番号が飛ぶこと自体が目印になる）。
 */
function __trimContext(rows, ctx) {
  var keep = new Array(rows.length);
  for (var i = 0; i < rows.length; i++) {
    if (rows[i].type !== 'equal') {
      var lo = Math.max(0, i - ctx);
      var hi = Math.min(rows.length - 1, i + ctx);
      for (var j = lo; j <= hi; j++) keep[j] = true;
    }
  }
  var out = [];
  for (var k = 0; k < rows.length; k++) if (keep[k]) out.push(rows[k]);
  return out;
}

function __run(before_ddl, after_ddl, left_label, right_label, options_json) {
  var opts = __opts(options_json);

  var a = (before_ddl === null || before_ddl === undefined || before_ddl === '')
    ? [] : splitLines(before_ddl);
  var b = (after_ddl === null || after_ddl === undefined || after_ddl === '')
    ? [] : splitLines(after_ddl);

  if (a.length === 0 && b.length === 0) {
    return __notice('DDL が空です。key の指定を確認してください。');
  }
  // LCS は O(n*m)。UDF のメモリと実行時間の保険。
  if ((a.length + 1) * (b.length + 1) > 4000000) {
    return __notice('行数が多すぎるため差分計算を中止しました（' + a.length + ' 行 x ' + b.length + ' 行）。');
  }

  var rows = build2Way(a, b);

  var ctx = opts.contextLines;
  if (typeof ctx === 'number' && ctx >= 0 && isFinite(ctx)) {
    var trimmed = __trimContext(rows, ctx);
    if (trimmed.length === 0) return __notice('差分はありません。');
    rows = trimmed;
  }

  var html = renderFragment2(left_label || 'before', right_label || 'after', rows, opts);

  var mode = opts.mode || 'inline';
  if (mode === 'class') {
    // CSS はテンプレート側（DIFF_CSS の出力）に置く前提。カラムが一番小さくなる。
    return __split(html).markup;
  }
  if (mode === 'embed') {
    // 単体で完結しつつ CSS を重複排除する中間案。
    var s = __split(html);
    return '<style>\\n' + __rulesToCss(s.rules) + '\\n</style>\\n' + s.markup;
  }
  return html; // 'inline'（既定）
}

return __run(before_ddl, after_ddl, left_label, right_label, options_json);
`.trim();

// DIFF_CSS 用のドライバ。
// 全パターンを網羅する内部 fixture を描画して、そこに出る CSS 規則を集める。
// markup と同じコードから作るので、クラス名が食い違うことがない。
const cssDriver = `
var __FIX_A = [
  '-- コメント行',
  'SELECT',
  '  a,',
  '  b,',
  '  削除される行',
  "  'literal' AS s,",
  '  123 AS n',
  'FROM t',
  'WHERE x = 1'
].join('\\n');

var __FIX_B = [
  '-- コメント行（変更後）',
  'SELECT',
  '  a,',
  '  b2,',
  "  'literal' AS s,",
  '  123 AS n,',
  '  追加された行',
  'FROM t',
  'INNER JOIN u USING (a)',
  'WHERE x = 2'
].join('\\n');

function __fixtureCss(opts) {
  var rules = {};
  function collect(a, b, la, lb) {
    var r = __split(renderFragment2(la, lb, build2Way(a, b), opts)).rules;
    for (var k in r) rules[k] = r[k];
  }
  // 変更なし / 追加 / 削除 / 行内変更 / 予約語 / リテラル / コメント
  collect(splitLines(__FIX_A), splitLines(__FIX_B), 'base', 'after');
  // 片側だけ（View の新規作成・削除）で出るハッチ
  collect([], splitLines('SELECT 1'), 'none', 'new');
  collect(splitLines('SELECT 1'), [], 'old', 'none');
  return __rulesToCss(rules);
}

return __fixtureCss(__opts(options_json));
`.trim();

const htmlBody = [diffJs, '', renderJs, '', shared, '', htmlDriver].join('\n');
const cssBody = [diffJs, '', renderJs, '', shared, '', cssDriver].join('\n');

// --- 生成した本体を Node 上で実行して検証する ---------------------------
const diffHtml = new Function(
  'before_ddl', 'after_ddl', 'left_label', 'right_label', 'options_json', htmlBody
);
const diffCss = new Function('options_json', cssBody);

const ddlA = await readFile(join(here, '..', 'ddl_diff_viz', 'samples', 'before.sql'), 'utf8');
const ddlB = await readFile(join(here, '..', 'ddl_diff_viz', 'samples', 'after.sql'), 'utf8');

const L = 'mart.v_daily_sales @ 2026-08-01';
const R = 'mart.v_daily_sales @ 2026-08-17';
const inline = diffHtml(ddlA, ddlB, L, R, null);
const classed = diffHtml(ddlA, ddlB, L, R, '{"mode":"class"}');
const embed = diffHtml(ddlA, ddlB, L, R, '{"mode":"embed"}');
const css = diffCss(null);
const ctx1 = diffHtml(ddlA, ddlB, 'a', 'b', '{"contextLines":2}');
const same = diffHtml(ddlA, ddlA, 'a', 'b', '{"contextLines":3}');
const empty = diffHtml(null, null, 'a', 'b', null);
const oneSide = diffHtml(null, 'SELECT 1', 'a', 'b', '{"mode":"class"}');
const badOpts = diffHtml(ddlA, ddlB, 'a', 'b', '{ this is not json');

const inlineText = inline.replace(/<[^>]*>/g, '');
const usedClasses = [...new Set([...classed.matchAll(/class="(d[0-9a-z]+)"/g)].map((m) => m[1]))];
const cssClasses = new Set([...css.matchAll(/^\.(d[0-9a-z]+)\{/gm)].map((m) => m[1]));
const oneSideClasses = [...new Set([...oneSide.matchAll(/class="(d[0-9a-z]+)"/g)].map((m) => m[1]))];

const checks = [
  ['差分 HTML が生成される', inline.includes('<table') && inlineText.includes('CREATE OR REPLACE VIEW')],
  ['ラベルが反映される', inlineText.includes('2026-08-01')],
  ['inline モードは自己完結（class 属性なし）', !/\sclass=/.test(inline)],
  ['<html>/<body> を含まない', !/<\/?(html|body)\b/i.test(inline)],
  ['行内の単語差分がハイライトされる', inline.includes('border-radius:2px')],
  ['class モードは style 属性を残さない', !/ style="/.test(classed)],
  ['class モードは inline より小さい', classed.length < inline.length],
  ['DIFF_CSS が markup の全クラスを網羅する', usedClasses.every((c) => cssClasses.has(c))],
  ['片側のみのケースも DIFF_CSS が網羅する', oneSideClasses.every((c) => cssClasses.has(c))],
  ['クラス名が決定的（2 回生成して一致）',
    diffHtml(ddlA, ddlB, L, R, '{"mode":"class"}') === classed],
  ['embed モードは style ブロックを含み自己完結', embed.includes('<style>') && embed.includes('</style>')],
  ['embed モードは inline より小さい', embed.length < inline.length],
  ['contextLines で小さくなる', ctx1.length < inline.length],
  ['contextLines でも差分行は残る', ctx1.includes('currency')],
  ['差分なし + contextLines は案内を返す', same.includes('差分はありません')],
  ['両方空なら案内を返す', empty.includes('DDL が空です')],
  ['片側だけでも描画できる', oneSide.includes('SELECT') && oneSide.includes('<table')],
  ['壊れた options_json でも落ちない', badOpts.includes('<table')],
];

let failed = 0;
for (const [name, ok] of checks) {
  if (!ok) failed++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}`);
}

const kb = (s) => (Buffer.byteLength(s) / 1024).toFixed(1) + ' KB';
console.log(`
${checks.length - failed}/${checks.length} passed

カラムに載る文字列（サンプル: ${ddlA.split('\n').length} 行 → ${ddlB.split('\n').length} 行）
  inline （既定・自己完結）     ${kb(inline)}
  embed  （style 同梱・自己完結）${kb(embed)}
  class  （CSS はテンプレート側）${kb(classed)}
  DIFF_CSS() の出力              ${kb(css)}  ${cssClasses.size} 規則・固定長`);

if (failed > 0) process.exit(1);
if (process.argv.includes('--check')) process.exit(0);

// --- SQL を書き出す ----------------------------------------------------
const header = `-- =====================================================================
-- DDL 差分を HTML で返す BigQuery UDF
--
-- Looker Studio のコミュニティ ビジュアライゼーション "Templated Record" に
-- HTML 文字列のカラムを渡して描画させるためのもの。
-- Templated Record はギャラリー掲載品なので公開元がホストしており、
-- こちらで GCS バケットを公開する必要がない。
--
-- ※ このファイルは build_udf.mjs が生成する。直接編集しないこと。
--    元コードは diff_html/ の VS Code 拡張の lib/diff.js / lib/render.js。
--    再生成: node looker_studio/templated_record/build_udf.mjs
--
-- PROJECT / DATASET は自分の環境に置換すること。
-- =====================================================================


-- ---------------------------------------------------------------------
-- DIFF_HTML — 2 つの DDL から差分 HTML を返す
--
-- 引数:
--   before_ddl    変更前の DDL
--   after_ddl     変更後の DDL
--   left_label    左ペインの見出し（NULL なら 'before'）
--   right_label   右ペインの見出し（NULL なら 'after'）
--   options_json  表示オプション。NULL または '{}' で既定。
--
-- options_json のキー:
--   mode          'inline'（既定）… すべてインライン CSS。単体で完結する
--                 'class'          … class 付き markup のみ。CSS は DIFF_CSS() の
--                                    出力を Templated Record のテンプレートに貼る。
--                                    カラムに載る文字列が最小になる
--                 'embed'          … <style> を先頭に付けた自己完結版。
--                                    inline より小さく、テンプレート編集も不要
--   contextLines  変更行の前後 N 行だけ描画する（さらに小さくする）
--   fontSize / lineHeight
--   colors.baseColor / colors.afterColor
--   diffLineOpacity / diffCharOpacity
--   syntax.keyword / syntax.literal / syntax.comment
--
-- 例:
--   DIFF_HTML(b, a, 'v1', 'v2', '{"mode":"class","contextLines":3}')
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION \`PROJECT.DATASET.DIFF_HTML\`(
  before_ddl   STRING,
  after_ddl    STRING,
  left_label   STRING,
  right_label  STRING,
  options_json STRING
)
RETURNS STRING
LANGUAGE js AS r"""
${htmlBody}
""";


-- ---------------------------------------------------------------------
-- DIFF_CSS — mode='class' のときにテンプレートへ貼る CSS を返す
--
--   SELECT \`PROJECT.DATASET.DIFF_CSS\`(NULL);
--
-- 結果を <style> … </style> で囲んで Templated Record のテンプレートに貼る。
-- 内部で全パターン（変更なし / 追加 / 削除 / 行内変更 / ハッチ / 予約語 /
-- リテラル / コメント）を描画して、そこに出る規則を集めている。
-- markup と同じコードから作るのでクラス名が食い違うことはない。
--
-- options_json は DIFF_HTML と同じものを渡すこと。色やフォントを変えた場合、
-- CSS 側も同じ設定で作り直す必要がある。
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION \`PROJECT.DATASET.DIFF_CSS\`(options_json STRING)
RETURNS STRING
LANGUAGE js AS r"""
${cssBody}
""";
`;

const outPath = join(here, 'ddl_diff_html.sql');
await writeFile(outPath, header);
console.log(`\nwrote ${outPath} (${(Buffer.byteLength(header) / 1024).toFixed(1)} KB)`);
