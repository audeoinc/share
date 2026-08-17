// ローカルプレビュー兼スモークテスト。
//
//   npm run preview   -> dist/preview.html を生成（ブラウザで開いて見た目を確認）
//   npm test          -> 生成せず、想定どおりの HTML が出ているかだけ検証
//
// Looker Studio 上と同じ src/viz.js の buildHtml() を、dscc が渡してくるのと
// 同じ形（objectTransform 形式 + style）のモックデータで呼んでいる。
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const here = dirname(fileURLToPath(import.meta.url));
const rootDir = join(here, '..');
const require = createRequire(import.meta.url);
const { buildHtml } = require(join(rootDir, 'src', 'viz.js'));

const ddlV1 = await readFile(join(rootDir, 'samples', 'before.sql'), 'utf8');
const ddlV2 = await readFile(join(rootDir, 'samples', 'after.sql'), 'utf8');
const ddlV3 = ddlV2.replace("'CONFIRMED'", "'CONFIRMED', 'SHIPPED'").replace('DESC', 'ASC');

// dscc の objectTransform は各フィールドを配列で渡してくる。
// BigQuery 側は (key, ddl) の 2 列だけ。
const row = (key, ddl) => ({ key: [key], ddl: [ddl] });

// カラー系は {color, opacity}、FONT_SIZE は "12px"、CHECKBOX は boolean という
// Looker Studio 実物の形を再現。
const baseStyle = {
  beforeKey: { value: '', defaultValue: '' },
  afterKey: { value: '', defaultValue: '' },
  swap: { value: false, defaultValue: false },
  fontFamily: { value: '', defaultValue: '' },
  fontSize: { value: '12px', defaultValue: '12px' },
  lineHeight: { value: '1.35', defaultValue: '1.35' },
  baseColor: { value: { color: '#E17B7B', opacity: 1 }, defaultValue: '#E17B7B' },
  afterColor: { value: { color: '#93AE68', opacity: 1 }, defaultValue: '#93AE68' },
  diffLineOpacity: { value: 0.3, defaultValue: 0.3 },
  diffCharOpacity: { value: 0.55, defaultValue: 0.55 },
  syntaxKeyword: { value: { color: '#CF222E' }, defaultValue: '#CF222E' },
  syntaxLiteral: { value: { color: '#098658' }, defaultValue: '#098658' },
  syntaxComment: { value: { color: '#6E7781' }, defaultValue: '#6E7781' },
};
const withStyle = (over) => ({ ...baseStyle, ...over });

const scenarios = [
  {
    title: '1. key を 2 つ選択（基本ケース）',
    rows: [row('v_daily_sales @ 2026-08-01', ddlV1), row('v_daily_sales @ 2026-08-17', ddlV2)],
    style: baseStyle,
    checks: [
      ['両方の key がペイン見出しに出る', (h, t) => t.includes('2026-08-01') && t.includes('2026-08-17')],
      ['増減バッジが出る', (h, t) => /\+\d/.test(t) && /−\d/.test(t)],
      ['行内の単語差分がハイライトされる', (h) => h.includes('border-radius:2px')],
    ],
  },
  {
    title: '2. 左右を入れ替え（swap = true）',
    rows: [row('v_daily_sales @ 2026-08-01', ddlV1), row('v_daily_sales @ 2026-08-17', ddlV2)],
    style: withStyle({ swap: { value: true, defaultValue: false } }),
    checks: [
      // 左ペインが 08-17 になっていること = 見出しの登場順が入れ替わる
      ['左ペインが 2026-08-17 になる', (h, t) => t.indexOf('2026-08-17') < t.indexOf('2026-08-01')],
    ],
  },
  {
    title: '3. 3 件以上選択されている（先頭 2 件を使い、警告を出す）',
    rows: [
      row('v_daily_sales @ 2026-08-01', ddlV1),
      row('v_daily_sales @ 2026-08-17', ddlV2),
      row('v_daily_sales @ 2026-08-20', ddlV3),
    ],
    style: baseStyle,
    checks: [['3 件選択されている旨の警告が出る', (h, t) => t.includes('3 件選択されています')]],
  },
  {
    title: '4. スタイル設定で key を明示（1 件目と 3 件目を比較）',
    rows: [
      row('v_daily_sales @ 2026-08-01', ddlV1),
      row('v_daily_sales @ 2026-08-17', ddlV2),
      row('v_daily_sales @ 2026-08-20', ddlV3),
    ],
    style: withStyle({
      beforeKey: { value: 'v_daily_sales @ 2026-08-01', defaultValue: '' },
      afterKey: { value: 'v_daily_sales @ 2026-08-20', defaultValue: '' },
    }),
    checks: [
      ['指定した 2 件が見出しに出る', (h, t) => t.includes('2026-08-01') && t.includes('2026-08-20')],
      ['指定外の key は見出しに出ない', (h, t) => !t.includes('2026-08-17')],
    ],
  },
  {
    title: '5. 存在しない key を指定（警告して自動選択にフォールバック）',
    rows: [row('v_daily_sales @ 2026-08-01', ddlV1), row('v_daily_sales @ 2026-08-17', ddlV2)],
    style: withStyle({ beforeKey: { value: 'typo-key', defaultValue: '' } }),
    checks: [['見つからない旨の警告が出る', (h, t) => t.includes('が見つかりません')]],
  },
  {
    title: '6. key が 1 件しか選択されていない',
    rows: [row('v_daily_sales @ 2026-08-01', ddlV1)],
    style: baseStyle,
    checks: [['2 つ選択を促す案内が出る', (h, t) => t.includes('2 つ選択してください')]],
  },
  {
    title: '7. 差分なし（同じ DDL の 2 件）',
    rows: [row('prod.v_untouched', ddlV1), row('dev.v_untouched', ddlV1)],
    style: baseStyle,
    checks: [['「変更なし」が出る', (h, t) => t.includes('変更なし')]],
  },
  {
    title: '8. データなし',
    rows: [],
    style: baseStyle,
    checks: [['フィールド割り当てを促す案内が出る', (h, t) => t.includes('データがありません')]],
  },
];

// --- 実行 -------------------------------------------------------------
let failed = 0;
let total = 0;
let body = '';

for (const sc of scenarios) {
  const html = buildHtml(sc.rows, sc.style);
  // ペイン見出しは nameDiff() が差異部分を <span> で囲むため、
  // 素の文字列では一致しない。タグを剥がしたテキストも渡す。
  const text = html.replace(/<[^>]*>/g, '');

  console.log(`\n${sc.title}`);
  for (const [name, fn] of sc.checks) {
    total++;
    let ok = false;
    try { ok = !!fn(html, text); } catch (e) { ok = false; }
    if (!ok) failed++;
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}`);
  }

  body +=
    `<h2 style="font:600 14px/1.6 'Roboto',system-ui,sans-serif;color:#57606A;` +
    `margin:28px 0 0;padding-top:14px;border-top:1px solid #D0D7DE">${sc.title}</h2>\n` +
    html + '\n';
}

// 全シナリオ共通の不変条件
const all = scenarios.map((sc) => buildHtml(sc.rows, sc.style)).join('');
for (const [name, ok] of [
  ['<html>/<body> を含まないフラグメントである', !/<\/?(html|body)\b/i.test(all)],
  ['style の色が反映されている', all.toLowerCase().includes('#e17b7b')],
  ['SQL シンタックスハイライトが効いている', all.toLowerCase().includes('#cf222e')],
]) {
  total++;
  if (!ok) failed++;
  console.log(`\n  ${ok ? 'PASS' : 'FAIL'}  ${name}`);
}

console.log(`\n${total - failed}/${total} passed`);

if (!process.argv.includes('--check')) {
  await mkdir(join(rootDir, 'dist'), { recursive: true });
  const css = await readFile(join(rootDir, 'src', 'index.css'), 'utf8');
  const page =
    '<!doctype html>\n<html lang="ja">\n<head>\n<meta charset="utf-8">\n' +
    '<title>DDL Diff preview</title>\n<style>\n' + css + '</style>\n</head>\n' +
    '<body>\n<div id="ddl-diff-root">\n' + body + '\n</div>\n</body>\n</html>\n';
  const out = join(rootDir, 'dist', 'preview.html');
  await writeFile(out, page);
  console.log(`wrote ${out}`);
}

process.exit(failed === 0 ? 0 : 1);
