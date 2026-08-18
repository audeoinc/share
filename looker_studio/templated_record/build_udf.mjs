// diff_html/ の拡張の lib/ から、BigQuery の JS UDF (DIFF_HTML) を生成する。
//
//   node build_udf.mjs          -> ddl_diff_html.sql を生成
//   node build_udf.mjs --check  -> 生成せず、Node 上で UDF 本体を実行して検証だけ
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

// UDF の入口。パラメータ名は CREATE FUNCTION の引数名と一致させる。
const driver = `
/* ------------------------------------------------------------------
 * ここから下は BigQuery UDF 用のドライバ（build_udf.mjs が付加）
 * ------------------------------------------------------------------ */

function __notice(text) {
  return '<div style="padding:8px 12px;border:1px solid #D0D7DE;border-left:4px solid #D0D7DE;' +
    'border-radius:4px;background:#F6F8FA;color:#57606A;' +
    "font:13px/1.6 'Roboto','Segoe UI',system-ui,sans-serif\\">" +
    String(text).replace(/[<>&]/g, '') + '</div>';
}

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
  var opts = {};
  if (options_json) {
    try { opts = JSON.parse(options_json) || {}; } catch (e) { opts = {}; }
  }

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
    // 全行同一なら間引いた結果が空になるので、その場合は案内を返す
    if (trimmed.length === 0) return __notice('差分はありません。');
    rows = trimmed;
  }

  return renderFragment2(
    left_label || 'before',
    right_label || 'after',
    rows,
    opts
  );
}

return __run(before_ddl, after_ddl, left_label, right_label, options_json);
`.trim();

const body = [diffJs, '', renderJs, '', driver].join('\n');

// --- 生成した本体を Node 上で実行して検証する ---------------------------
const run = new Function(
  'before_ddl', 'after_ddl', 'left_label', 'right_label', 'options_json', body
);

const ddlA = await readFile(join(here, '..', 'ddl_diff_viz', 'samples', 'before.sql'), 'utf8');
const ddlB = await readFile(join(here, '..', 'ddl_diff_viz', 'samples', 'after.sql'), 'utf8');

const full = run(ddlA, ddlB, '2026-08-01', '2026-08-17', null);
const ctx1 = run(ddlA, ddlB, 'a', 'b', JSON.stringify({ contextLines: 2 }));
const same = run(ddlA, ddlA, 'a', 'b', JSON.stringify({ contextLines: 3 }));
const empty = run(null, null, 'a', 'b', null);
const oneSide = run(null, 'SELECT 1', 'a', 'b', null);
const badOpts = run(ddlA, ddlB, 'a', 'b', '{ this is not json');

// SQL は 1 語ずつ <span> で色分けされるので、素の文字列では一致しない
const fullText = full.replace(/<[^>]*>/g, '');

const checks = [
  ['差分 HTML が生成される', full.includes('<table') && fullText.includes('CREATE OR REPLACE VIEW')],
  ['ラベルが反映される', fullText.includes('2026-08-01')],
  ['インライン CSS で自己完結（class 属性なし）', !/\sclass=/.test(full)],
  ['<html>/<body> を含まない', !/<\/?(html|body)\b/i.test(full)],
  ['行内の単語差分がハイライトされる', full.includes('border-radius:2px')],
  ['contextLines で小さくなる', ctx1.length < full.length],
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
console.log(
  `\n${checks.length - failed}/${checks.length} passed  |  ` +
  `UDF 本体 ${(Buffer.byteLength(body) / 1024).toFixed(1)} KB  |  ` +
  `出力 HTML: 全行 ${(Buffer.byteLength(full) / 1024).toFixed(0)} KB / ` +
  `前後2行 ${(Buffer.byteLength(ctx1) / 1024).toFixed(0)} KB`
);

if (failed > 0) process.exit(1);
if (process.argv.includes('--check')) process.exit(0);

// --- SQL を書き出す ----------------------------------------------------
const sql = `-- =====================================================================
-- DIFF_HTML — 2 つの DDL から差分 HTML（インライン CSS の自己完結フラグメント）を返す
--
-- Looker Studio のコミュニティ ビジュアライゼーション "Templated Record" に
-- HTML 文字列のカラムを渡して描画させるための UDF。
-- Templated Record はギャラリー掲載品なので公開元がホストしており、
-- こちらで GCS バケットを公開する必要がない。
--
-- ※ このファイルは build_udf.mjs が生成する。直接編集しないこと。
--    元コードは diff_html/ の VS Code 拡張の lib/diff.js / lib/render.js。
--    再生成: node looker_studio/templated_record/build_udf.mjs
--
-- 引数:
--   before_ddl    変更前の DDL
--   after_ddl     変更後の DDL
--   left_label    左ペインの見出し（NULL なら 'before'）
--   right_label   右ペインの見出し（NULL なら 'after'）
--   options_json  表示オプション。NULL または '{}' で既定。例:
--                   {"contextLines": 3}        変更行の前後 3 行だけ描画（HTML を小さくする）
--                   {"fontSize": 12, "lineHeight": 1.35}
--                   {"colors": {"baseColor": "#E17B7B", "afterColor": "#93AE68"}}
--                   {"diffLineOpacity": 0.30, "diffCharOpacity": 0.55}
--                   {"syntax": {"keyword": "#CF222E", "literal": "#098658", "comment": "#6E7781"}}
--
-- PROJECT / DATASET は自分の環境に置換すること。
-- =====================================================================
CREATE OR REPLACE FUNCTION \`PROJECT.DATASET.DIFF_HTML\`(
  before_ddl   STRING,
  after_ddl    STRING,
  left_label   STRING,
  right_label  STRING,
  options_json STRING
)
RETURNS STRING
LANGUAGE js AS r"""
${body}
""";
`;

const outPath = join(here, 'ddl_diff_html.sql');
await writeFile(outPath, sql);
console.log(`\nwrote ${outPath} (${(Buffer.byteLength(sql) / 1024).toFixed(1)} KB)`);
