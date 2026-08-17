# release/ — GCS に置くファイル一式

**このディレクトリは `npm run release` が生成する。直接編集しないこと。**

`lib/` や `viz.js` や `@google/dscc` は `index.js` にバンドル済みなので、
GCS に置くのはここにある 5 ファイルだけ。

| ファイル | 用途 |
|---|---|
| `manifest.json` | Looker Studio が最初に読む。**GCS パスを埋めてからアップロードする** |
| `index.js` | バンドル済みの本体（30.4 KB） |
| `index.json` | データ / スタイル設定の定義 |
| `index.css` | iframe 側のスクロール領域 |
| `icon.png` | コンポーネント選択画面のアイコン |

手順は [../README.md](../README.md) の「手動で配置する場合」を参照。
