// index.json / index.css を dist/ にコピーする（deploy.sh は dist/ だけを見る）。
import { copyFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const rootDir = join(here, '..');

await mkdir(join(rootDir, 'dist'), { recursive: true });
for (const f of ['index.json', 'index.css']) {
  await copyFile(join(rootDir, 'src', f), join(rootDir, 'dist', f));
}
console.log('copied index.json, index.css -> dist/');
