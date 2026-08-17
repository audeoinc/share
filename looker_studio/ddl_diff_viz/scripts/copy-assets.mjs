// index.json / index.css / icon.png を dist/ にコピーする。
// dist/ にある manifest 以外の 4 ファイルがそのまま GCS に置くものになる。
import { copyFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const rootDir = join(here, '..');

await mkdir(join(rootDir, 'dist'), { recursive: true });
for (const f of ['index.json', 'index.css', 'icon.png']) {
  await copyFile(join(rootDir, 'src', f), join(rootDir, 'dist', f));
}
console.log('copied index.json, index.css, icon.png -> dist/');
