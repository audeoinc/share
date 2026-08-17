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

const before = await readFile(join(rootDir, 'samples', 'before.sql'), 'utf8');
const after = await readFile(join(rootDir, 'samples', 'after.sql'), 'utf8');

// dscc の objectTransform は各フィールドを配列で渡してくる。
const rows = [
  { viewKey: ['proj.mart.v_daily_sales'], beforeDdl: [before], afterDdl: [after] },
  // View 新規作成（変更前が空）のケース
  { viewKey: ['proj.mart.v_new_view'], beforeDdl: [''], afterDdl: ['CREATE VIEW `proj.mart.v_new_view` AS\nSELECT 1 AS x'] },
  // 変更なしのケース
  { viewKey: ['proj.mart.v_untouched'], beforeDdl: ['SELECT 1'], afterDdl: ['SELECT 1'] },
];

// カラー系は {color, opacity}、FONT_SIZE は "12px" という Looker Studio 実物の形を再現。
const style = {
  leftLabel: { value: '2026-08-01', defaultValue: 'before' },
  rightLabel: { value: '2026-08-17', defaultValue: 'after' },
  maxViews: { value: '', defaultValue: '10' },
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

const html = buildHtml(rows, style);

// ペイン見出しは nameDiff() が差異部分を <span> で囲むため、
// 素の文字列では一致しない。タグを剥がしてから検証する。
const text = html.replace(/<[^>]*>/g, '');

// --- スモークテスト ---------------------------------------------------
const checks = [
  ['3 つの View がすべて描画される', (h) => (h.match(/proj\.mart\.v_/g) || []).length >= 3],
  ['増減バッジが出る', (h) => h.includes('+') && h.includes('−')],
  ['変更なしの View にはその旨が出る', (h) => h.includes('変更なし')],
  ['ペインの見出しに style の値が反映される', () => text.includes('2026-08-01') && text.includes('2026-08-17')],
  ['カラーオブジェクトから色を取り出せている', (h) => h.toLowerCase().includes('#e17b7b')],
  ['SQL シンタックスハイライトが効いている', (h) => h.toLowerCase().includes('#cf222e')],
  ['<html>/<body> を含まないフラグメントである', (h) => !/<\/?(html|body)\b/i.test(h)],
];

let failed = 0;
for (const [name, fn] of checks) {
  const ok = fn(html);
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
}
console.log(`\nHTML ${(Buffer.byteLength(html) / 1024).toFixed(1)} KB / ${checks.length - failed}/${checks.length} passed`);

if (!process.argv.includes('--check')) {
  await mkdir(join(rootDir, 'dist'), { recursive: true });
  const css = await readFile(join(rootDir, 'src', 'index.css'), 'utf8');
  const page =
    '<!doctype html>\n<html lang="ja">\n<head>\n<meta charset="utf-8">\n' +
    '<title>DDL Diff preview</title>\n<style>\n' + css + '</style>\n</head>\n' +
    '<body>\n<div id="ddl-diff-root">\n' + html + '\n</div>\n</body>\n</html>\n';
  const out = join(rootDir, 'dist', 'preview.html');
  await writeFile(out, page);
  console.log(`wrote ${out}`);
}

process.exit(failed === 0 ? 0 : 1);
