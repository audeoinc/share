// GCS に手で置くためのファイル一式を release/ に組み立てる。
//
// npm 実行環境がない人でも、リポジトリから release/ をダウンロードして
// Cloud Console でアップロードするだけで済むよう、成果物をコミットしておく。
// manifest.json だけは GCS のパスを埋める必要があるためプレースホルダのまま置く。
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const rootDir = join(here, '..');
const releaseDir = join(rootDir, 'release');

await mkdir(releaseDir, { recursive: true });

// バンドル済み JS はビルド成果物、それ以外は src からそのまま
await copyFile(join(rootDir, 'dist', 'index.js'), join(releaseDir, 'index.js'));
for (const f of ['index.json', 'index.css', 'icon.png', 'manifest.json']) {
  await copyFile(join(rootDir, 'src', f), join(releaseDir, f));
}

const size = (await readFile(join(releaseDir, 'index.js'))).byteLength;
await writeFile(
  join(releaseDir, 'README.md'),
  `# release/ — GCS に置くファイル一式\n\n` +
  `**このディレクトリは \`npm run release\` が生成する。直接編集しないこと。**\n\n` +
  `\`lib/\` や \`viz.js\` や \`@google/dscc\` は \`index.js\` にバンドル済みなので、\n` +
  `GCS に置くのはここにある 5 ファイルだけ。\n\n` +
  `| ファイル | 用途 |\n` +
  `|---|---|\n` +
  `| \`manifest.json\` | Looker Studio が最初に読む。**GCS パスを埋めてからアップロードする** |\n` +
  `| \`index.js\` | バンドル済みの本体（${(size / 1024).toFixed(1)} KB） |\n` +
  `| \`index.json\` | データ / スタイル設定の定義 |\n` +
  `| \`index.css\` | iframe 側のスクロール領域 |\n` +
  `| \`icon.png\` | コンポーネント選択画面のアイコン |\n\n` +
  `手順は [../README.md](../README.md) の「手動で配置する場合」を参照。\n`
);

console.log(`assembled release/ (index.js ${(size / 1024).toFixed(1)} KB)`);
