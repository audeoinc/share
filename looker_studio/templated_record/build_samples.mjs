// Templated Record 検証用のサンプル HTML を生成する。
//
//   node build_samples.mjs
//
// 生成済みの ddl_diff_html.sql から UDF 本体を抜き出して実行するので、
// ここで出るサンプルは BigQuery が実際に返す文字列と同一になる。
// （サンプル生成用に別実装を持つと、いつの間にか食い違う。）
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, 'samples');
await mkdir(outDir, { recursive: true });

const sql = await readFile(join(here, 'ddl_diff_html.sql'), 'utf8');

/** CREATE FUNCTION の r""" … """ から UDF 本体を取り出す。 */
function bodyOf(fnName) {
  const re = new RegExp(
    'CREATE OR REPLACE FUNCTION `PROJECT\\.DATASET\\.' + fnName + '`[\\s\\S]*?LANGUAGE js AS r"""([\\s\\S]*?)""";'
  );
  const m = sql.match(re);
  if (!m) throw new Error(`${fnName} の本体を ddl_diff_html.sql から取り出せませんでした`);
  return m[1];
}

const DIFF_HTML = new Function(
  'before_ddl', 'after_ddl', 'left_label', 'right_label', 'options_json', bodyOf('DIFF_HTML')
);
const DIFF_CSS = new Function('options_json', bodyOf('DIFF_CSS'));

const ddlA = await readFile(join(here, '..', 'ddl_diff_viz', 'samples', 'before.sql'), 'utf8');
const ddlB = await readFile(join(here, '..', 'ddl_diff_viz', 'samples', 'after.sql'), 'utf8');
const L = 'mart.v_daily_sales @ 2026-08-01';
const R = 'mart.v_daily_sales @ 2026-08-17';

const inline = DIFF_HTML(ddlA, ddlB, L, R, null);
const classed = DIFF_HTML(ddlA, ddlB, L, R, '{"mode":"class"}');
const embed = DIFF_HTML(ddlA, ddlB, L, R, '{"mode":"embed"}');
const css = DIFF_CSS(null);

// --- 検証 --------------------------------------------------------------
const used = [...new Set([...classed.matchAll(/class="(d[0-9a-z]+)"/g)].map((m) => m[1]))];
const defined = new Set([...css.matchAll(/^\.(d[0-9a-z]+)\{/gm)].map((m) => m[1]));
const checks = [
  ['markup に style 属性が残っていない', !/ style="/.test(classed)],
  ['DIFF_CSS が markup の全クラスを網羅', used.every((c) => defined.has(c))],
  ['未使用の CSS 規則が過剰でない', defined.size - used.length <= 10],
];
let failed = 0;
for (const [name, ok] of checks) {
  if (!ok) failed++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}`);
}

const kb = (s) => (Buffer.byteLength(s) / 1024).toFixed(1) + ' KB';
console.log(`
カラムに載る文字列
  inline ${kb(inline)}   embed ${kb(embed)}   class ${kb(classed)}
  DIFF_CSS() ${kb(css)}（${defined.size} 規則・固定長。markup で使用 ${used.length}）`);

// --- 規模別の実測 ------------------------------------------------------
function makeDdl(n, seed) {
  const out = ['CREATE OR REPLACE VIEW `proj.ds.v` AS', 'SELECT'];
  for (let i = 0; i < n; i++) {
    out.push(`  CAST(t.col_${i} AS STRING) AS column_name_${i}${i % 7 === seed ? '_v2' : ''},`);
  }
  out.push('FROM `proj.ds.base` t', "WHERE dt >= DATE '2026-01-01'");
  return out.join('\n');
}
console.log('\n規模別（カラムに載る文字列）');
console.log('  DDL 行数 |    inline |     embed |     class | class の削減');
for (const n of [50, 200, 500, 1000]) {
  const a = makeDdl(n, 3), b = makeDdl(n, 4);
  const i = Buffer.byteLength(DIFF_HTML(a, b, 'a', 'b', null)) / 1024;
  const e = Buffer.byteLength(DIFF_HTML(a, b, 'a', 'b', '{"mode":"embed"}')) / 1024;
  const c = Buffer.byteLength(DIFF_HTML(a, b, 'a', 'b', '{"mode":"class"}')) / 1024;
  console.log(
    `  ${String(n).padStart(7)} | ${i.toFixed(0).padStart(6)} KB | ${e.toFixed(0).padStart(6)} KB | ` +
    `${c.toFixed(0).padStart(6)} KB | ${(100 - c / i * 100).toFixed(0).padStart(9)}%`
  );
}

// --- 出力 --------------------------------------------------------------
const page = (title, head, body) =>
  `<!doctype html>\n<html lang="ja">\n<head>\n<meta charset="utf-8">\n<title>${title}</title>\n` +
  `${head}\n</head>\n<body style="margin:16px;background:#fff">\n${body}\n</body>\n</html>\n`;

await writeFile(join(outDir, '01_style_test.html'),
`<style>
  .ddl-test { padding: 12px; border: 2px solid #1A7F37; border-radius: 6px;
              background: #DAFBE1; color: #1A7F37;
              font: 600 14px/1.6 'Roboto', system-ui, sans-serif; }
  .ddl-test code { background: #FFEBE9; color: #82071E; padding: 1px 5px; border-radius: 3px; }
</style>
<div class="ddl-test">
  style ブロックが効いています（緑の枠・緑の背景）。
  <code>この部分が赤ければ子要素セレクタも効いています。</code>
</div>
`);

await writeFile(join(outDir, '02_diff_inline.html'), page('diff (mode=inline)', '', inline));
await writeFile(join(outDir, '03_diff_classed.html'),
  page('diff (mode=class + DIFF_CSS)', `<style>\n${css}\n</style>`, classed));
await writeFile(join(outDir, '04_template_style.html'),
`<!--
  mode='class' のとき Templated Record のテンプレートに貼る部分。
  中身は SELECT \`PROJECT.DATASET.DIFF_CSS\`(NULL) の出力そのもの。
  ここは固定。差分の内容が変わっても書き換え不要。
  この下にフィールド（markup が入ったカラム）を差し込む。
-->
<style>
${css}
</style>
`);
await writeFile(join(outDir, '05_column_markup.html'), classed);
await writeFile(join(outDir, '06_diff_embed.html'), page('diff (mode=embed)', '', embed));

// 07_radio_tabs_test.html は手書きの静的サンプル（このスクリプトは触らない）。
console.log(`\nwrote ${outDir}/01 … 06（07 は静的サンプルのため対象外）`);
process.exit(failed === 0 ? 0 : 1);
