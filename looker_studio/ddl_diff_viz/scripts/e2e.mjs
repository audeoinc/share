// dscc との結線を実ブラウザで検証する（npm run e2e）。
//
// preview.mjs は viz.js（純関数）だけを見るので、index.js の
// 「subscribeToData → objectTransform → innerHTML」の経路は素通しだった。
// 実際に真っ白になったのはここなので、Looker Studio が送るのと同じ形の
// RENDER メッセージを postMessage して、バンドル済み dist/index.js を叩く。
//
// playwright が入っていなければスキップする（必須の依存にはしない）。
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const rootDir = join(here, '..');

let chromium;
try {
  ({ chromium } = await import('playwright'));
} catch {
  console.log('SKIP: playwright が未インストールのため e2e をスキップします');
  console.log('      npm i -D playwright && npx playwright install chromium');
  process.exit(0);
}

const bundle = join(rootDir, 'dist', 'index.js');
try {
  await readFile(bundle);
} catch {
  console.error('dist/index.js がありません。先に npm run build を実行してください。');
  process.exit(1);
}

// 実際の config をそのまま使う（id のズレを検出できるようにする）
const config = JSON.parse(await readFile(join(rootDir, 'src', 'index.json'), 'utf8'));
// Looker Studio はフィールド割り当て結果を各要素の value に入れて渡してくる
for (const section of config.data) {
  for (const el of section.elements) {
    if (el.id === 'key') el.value = ['fld_key'];
    else if (el.id === 'ddl') el.value = ['fld_ddl'];
    else el.value = []; // 未割り当て（= configIds に寄与しない）
  }
}
for (const section of config.style || []) {
  for (const el of section.elements) el.value = el.defaultValue;
}
config.themeStyle = {};

const ddlA = await readFile(join(rootDir, 'samples', 'before.sql'), 'utf8');
const ddlB = await readFile(join(rootDir, 'samples', 'after.sql'), 'utf8');

// message.fields は配列（dscc の fieldsById が reduce する）。
// row は [dimensions..., metrics...] の順。
const renderMessage = {
  type: 'RENDER',
  config,
  fields: [
    { id: 'fld_key', name: 'key', concept: 'DIMENSION', type: 'TEXT' },
    { id: 'fld_ddl', name: 'ddl', concept: 'DIMENSION', type: 'TEXT' },
  ],
  dataResponse: {
    tables: [
      {
        id: 'DEFAULT',
        fields: [{ id: 'fld_key' }, { id: 'fld_ddl' }],
        rows: [
          ['mart.v_daily_sales @ 2026-08-01', ddlA],
          ['mart.v_daily_sales @ 2026-08-17', ddlB],
        ],
      },
    ],
    dateRanges: [],
    colorMap: {},
  },
};

const harness = join(rootDir, 'dist', 'e2e-harness.html');
await writeFile(
  harness,
  '<!doctype html><meta charset="utf-8"><title>e2e</title>\n' +
  `<style>${await readFile(join(rootDir, 'src', 'index.css'), 'utf8')}</style>\n` +
  '<script src="./index.js"></script>\n'
);

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
const page = await browser.newPage({ viewport: { width: 1100, height: 700 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));

// dscId が無いと dscc が例外を投げるので、Looker Studio と同じくクエリに付ける
await page.goto('file://' + harness + '?dscId=e2e-test');
await page.waitForTimeout(300);

const beforeText = (await page.locator('#ddl-diff-root').innerText().catch(() => '')).trim();

await page.evaluate((msg) => window.postMessage(msg, '*'), renderMessage);
await page.waitForTimeout(500);

const html = await page.locator('#ddl-diff-root').innerHTML().catch(() => '');
const text = html.replace(/<[^>]*>/g, '');
await page.screenshot({ path: join(rootDir, 'dist', 'e2e.png'), fullPage: true });
await browser.close();

const checks = [
  ['データ到着前にプレースホルダが出る', /読み込みました/.test(beforeText)],
  ['subscribeToData が例外を投げない', !/subscribeToData に失敗/.test(beforeText)],
  ['RENDER 受信でプレースホルダが差し替わる', !/データを待っています/.test(text)],
  ['描画エラーになっていない', !/描画に失敗/.test(text)],
  ['フィールド id が key / ddl として届く', !/フィールド id が想定と違います/.test(text)],
  ['0 行扱いになっていない', !/1 行もデータが渡ってきていません/.test(text)],
  ['両方の key が見出しに出る', text.includes('2026-08-01') && text.includes('2026-08-17')],
  ['増減バッジが出る', /\+\d/.test(text) && /−\d/.test(text)],
  ['SQL 行が描画されている', text.includes('CREATE OR REPLACE VIEW')],
  ['JS の未捕捉エラーがない', errors.length === 0],
];

console.log('--- データ到着前 ---');
console.log(beforeText || '(空)');
console.log('\n--- 検証 ---');
let failed = 0;
for (const [name, ok] of checks) {
  if (!ok) failed++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}`);
}
if (errors.length) console.log('\npageerror:\n' + errors.join('\n'));
console.log(`\n${checks.length - failed}/${checks.length} passed`);
process.exit(failed === 0 ? 0 : 1);
