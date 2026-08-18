// Templated Record 検証用のサンプル HTML を生成する。
//
//   node build_samples.mjs
//
// 目的:
//   render.js はすべてインライン CSS で吐くため HTML が DDL の約 21 倍になる。
//   Templated Record は <style> が使えるので、
//     ・共通の CSS  → テンプレート側に固定で置く
//     ・差分の markup → BigQuery のカラムで渡す
//   に分ければ、カラムに載せる文字列を大幅に小さくできる。
//
// クラス名は「style 属性の中身のハッシュ」から決める。内容や出現順に依存しない
// ので、どんな差分を描画しても同じ宣言には必ず同じクラス名が付く。これがないと
// テンプレート側の固定 CSS と markup 側のクラス名がズレる。
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const libDir = join(here, '..', 'ddl_diff_viz', 'src', 'lib');
const { splitLines, build2Way } = require(join(libDir, 'diff.js'));
const { renderFragment2 } = require(join(libDir, 'render.js'));

const outDir = join(here, 'samples');
await mkdir(outDir, { recursive: true });

/** FNV-1a → base36。短く決定的なクラス名を作る。 */
function hashClass(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return 'd' + h.toString(36);
}

/**
 * インライン CSS の HTML を「クラス付き markup」と「CSS 規則」に分解する。
 * 見た目は変えない（同じ宣言をクラスに移すだけ）。
 */
function split(html) {
  const rules = new Map(); // class -> declarations
  const markup = html.replace(/ style="([^"]*)"/g, (_m, css) => {
    const cls = hashClass(css);
    const prev = rules.get(cls);
    if (prev !== undefined && prev !== css) {
      throw new Error(`クラス名が衝突しました: ${cls}`);
    }
    rules.set(cls, css);
    return ` class="${cls}"`;
  });
  return { markup, rules };
}

function rulesToCss(rules) {
  return [...rules].sort().map(([cls, css]) => `.${cls}{${css}}`).join('\n');
}

const render = (a, b, la, lb) =>
  renderFragment2(la, lb, build2Way(splitLines(a), splitLines(b)), {});

// --- 1) 実サンプル -----------------------------------------------------
const ddlA = await readFile(join(here, '..', 'ddl_diff_viz', 'samples', 'before.sql'), 'utf8');
const ddlB = await readFile(join(here, '..', 'ddl_diff_viz', 'samples', 'after.sql'), 'utf8');
const inlineHtml = render(ddlA, ddlB, 'mart.v_daily_sales @ 2026-08-01', 'mart.v_daily_sales @ 2026-08-17');
const sample = split(inlineHtml);

// --- 2) 全パターンを網羅する fixture から共通 CSS を作る ----------------
// テンプレートに置く CSS が、実データで出てくるクラスを取りこぼさないようにする。
// 変更なし / 追加 / 削除 / 変更(行内差分) / ハッチ / 予約語 / リテラル / コメント を全部通す。
const fixA = [
  '-- コメント行',
  'SELECT',
  '  a,',
  '  b,',
  '  削除される行',
  "  'literal' AS s,",
  '  123 AS n',
  'FROM t',
  'WHERE x = 1',
].join('\n');
const fixB = [
  '-- コメント行（変更後）',
  'SELECT',
  '  a,',
  '  b2,',
  "  'literal' AS s,",
  '  123 AS n,',
  '  追加された行',
  'FROM t',
  'INNER JOIN u USING (a)',
  'WHERE x = 2',
].join('\n');
const fixture = split(render(fixA, fixB, 'base', 'after'));

// 片側だけ（View の新規作成・削除）でも新しいクラスが出ないか確認
const oneSided = split(render('', 'SELECT 1', 'なし', 'new'));

const templateRules = new Map([...fixture.rules, ...oneSided.rules, ...sample.rules]);
const templateCss = rulesToCss(templateRules);

// --- 3) 検証 -----------------------------------------------------------
const missing = [...sample.rules.keys()].filter((c) => !fixture.rules.has(c));
const checks = [
  ['markup に style 属性が残っていない', !/ style="/.test(sample.markup)],
  ['markup が class 属性を持つ', / class="d[0-9a-z]+"/.test(sample.markup)],
  ['クラス名が決定的（2 回生成して一致）', split(inlineHtml).markup === sample.markup],
  ['クラス名の衝突がない', templateRules.size === new Set(templateRules.keys()).size],
  ['共通 CSS が実サンプルのクラスを網羅している',
    [...sample.rules.keys()].every((c) => templateRules.has(c))],
];

let failed = 0;
for (const [name, ok] of checks) {
  if (!ok) failed++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}`);
}

const kb = (s) => (Buffer.byteLength(s) / 1024).toFixed(1) + ' KB';
console.log(`
サイズ比較（サンプルの DDL: ${splitLines(ddlA).length} 行 → ${splitLines(ddlB).length} 行）
  元の DDL 2 本            ${kb(ddlA + ddlB)}
  インライン CSS 版        ${kb(inlineHtml)}   ← 現在の DIFF_HTML の出力
  共通 CSS（テンプレート側）${kb(templateCss)}   ← 1 回だけ。カラムには載らない
  markup（カラムに載る分）  ${kb(sample.markup)}   ← ${(Buffer.byteLength(sample.markup) / Buffer.byteLength(inlineHtml) * 100).toFixed(0)}% に縮小
  CSS 規則の数              ${templateRules.size}`);

if (missing.length) console.log(`\n注意: fixture に無く実データにだけ出たクラス ${missing.length} 件`);

// --- 3-2) 規模別の実測 -------------------------------------------------
// CSS は固定長、markup だけが行数に比例するので、DDL が大きいほど分離の効きが良くなる。
function makeDdl(n, seed) {
  const out = ['CREATE OR REPLACE VIEW `proj.ds.v` AS', 'SELECT'];
  for (let i = 0; i < n; i++) {
    out.push(`  CAST(t.col_${i} AS STRING) AS column_name_${i}${i % 7 === seed ? '_v2' : ''},`);
  }
  out.push('FROM `proj.ds.base` t', "WHERE dt >= DATE '2026-01-01'");
  return out.join('\n');
}
console.log('\n規模別（カラムに載る文字列の大きさ）');
console.log('  DDL 行数 |  インライン |  class markup |  削減');
for (const n of [50, 200, 500, 1000]) {
  const h = render(makeDdl(n, 3), makeDdl(n, 4), 'a', 'b');
  const m = split(h).markup;
  const hi = Buffer.byteLength(h) / 1024, mi = Buffer.byteLength(m) / 1024;
  console.log(
    `  ${String(n).padStart(7)} | ${hi.toFixed(0).padStart(8)} KB | ${mi.toFixed(0).padStart(11)} KB | ` +
    `${(100 - mi / hi * 100).toFixed(0).padStart(4)}%`
  );
}

// --- 4) 出力 -----------------------------------------------------------
const page = (title, head, body) =>
  `<!doctype html>\n<html lang="ja">\n<head>\n<meta charset="utf-8">\n<title>${title}</title>\n` +
  `${head}\n</head>\n<body style="margin:16px;background:#fff">\n${body}\n</body>\n</html>\n`;

// 0. <style> が効くかどうかだけを見る最小サンプル
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

// 1. インライン CSS 版（現行の DIFF_HTML 出力そのもの）
await writeFile(join(outDir, '02_diff_inline.html'), page('diff (inline css)', '', inlineHtml));

// 2. style ブロック + class 版（見た目は 02 と同一）
await writeFile(join(outDir, '03_diff_classed.html'),
  page('diff (style block + class)', `<style>\n${templateCss}\n</style>`, sample.markup));

// 3. テンプレート側に貼る CSS
await writeFile(join(outDir, '04_template_style.html'),
`<!--
  Templated Record のテンプレートに貼る部分。
  ここは固定。差分の内容が変わっても書き換え不要。
  この下にフィールド（markup が入ったカラム）を差し込む。
-->
<style>
${templateCss}
</style>
`);

// 4. カラムに入る markup（BigQuery が返す文字列そのもの）
await writeFile(join(outDir, '05_column_markup.html'), sample.markup);

console.log(`\nwrote ${outDir}/01_style_test.html … 05_column_markup.html`);
process.exit(failed === 0 ? 0 : 1);
