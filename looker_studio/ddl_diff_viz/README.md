# DDL Diff — Looker Studio コミュニティ ビジュアライゼーション

BigQuery View の DDL を 2 つ受け取り、**ブラウザ内で差分を計算して GitHub compare 風に
左右 2 ペインで表示する** Looker Studio のコミュニティ ビジュアライゼーション。

![プレビュー](docs/preview.png)

## 設計

```
BigQuery                    Looker Studio (viz の iframe 内)
──────────────────────      ────────────────────────────────────────
1 View = 1 行                dscc.subscribeToData
  view_key                →   ↓
  before_ddl              →  lib/diff.js   … LCS で行差分 + 行内の単語差分
  after_ddl               →  lib/render.js … インライン CSS の HTML を生成
                              ↓
                             root.innerHTML = html
```

**DDL をそのまま渡し、HTML はビジュアライゼーション側で作る。** 事前生成した HTML を
DB に持たせない理由は 2 つ:

- インライン CSS の HTML は元の DDL の **約 21 倍**に膨らむ（実測: 200 行の DDL → 201KB）。
  一方レンダリングは **20〜80ms** しかかからないので、事前生成は「20ms の CPU を節約するために
  1 セル数百 KB を運ぶ」取引になる
- 事前生成すると比較の組み合わせが固定される。DDL を渡す方式なら、レポート側のコントロールで
  **任意の 2 スナップショットを比較**できる

差分ロジックは `diff_html/` の VS Code 拡張（`lib/diff.js` / `lib/render.js`）をそのまま
ベンダリングしている。外部依存ゼロ・`vscode` 非依存なのでブラウザにそのまま載る。
出力が**全部インライン CSS の自己完結フラグメント**である点は、外部ネットワークにアクセス
できないコミュニティ ビジュアライゼーションの sandbox と相性がいい（外部 CSS を読み込む
diff2html だと CSS の同梱が別途必要になる）。

## ディレクトリ

```
src/
  index.js       dscc とのつなぎ込みだけ（購読 → innerHTML）
  viz.js         HTML 生成の中核。DOM にも dscc にも依存しない純関数
  lib/diff.js    ベンダリング（差分ロジック）
  lib/render.js  ベンダリング（HTML レンダリング）
  index.json     データ / スタイル設定の定義（Looker Studio のプロパティパネル）
  index.css      iframe 側のスクロール領域だけ
  manifest.json  デプロイ時に GCS パスを埋め込むテンプレート
scripts/
  preview.mjs    ローカルプレビュー兼スモークテスト
samples/         動作確認用の before/after SQL
deploy.sh        ビルド + GCS へアップロード
```

`viz.js` を DOM 非依存にしてあるので、**ローカルプレビューと Looker Studio 上が同じコードパス**を通る。

## 開発

```bash
npm install
npm test        # スモークテスト（HTML を生成せず検証だけ）
npm run preview # dist/preview.html を生成 → ブラウザで開いて見た目を確認
npm run build   # dist/index.js（bundle, 約 25KB）+ index.json + index.css
```

## デプロイ

```bash
GCS_BUCKET=my-bucket GCS_PREFIX=viz/ddl-diff ./deploy.sh
```

`manifest.json` の GCS パスを埋め込み、`manifest.json` / `index.js` / `index.json` /
`index.css` を `gs://my-bucket/viz/ddl-diff/` に配置する。
`Cache-Control: no-cache` を付けているので、再デプロイが即反映される。

**レポート閲覧者がバケットを読める必要がある。** deploy.sh の最後に IAM 付与コマンドを表示する。
DDL の中身がビジュアライゼーション経由で見えるので、`allUsers` ではなく
`domain:` での限定を推奨。

## BigQuery 側のデータソース

**1 View = 1 行、DDL は文字列カラム**という形にするだけ。UDF は不要。

```sql
CREATE OR REPLACE VIEW `PROJECT.DATASET.v_ddl_pairs` AS
WITH
before_side AS (
  SELECT FORMAT('%s.%s.%s', table_catalog, table_schema, table_name) AS view_key, ddl
  FROM `PROJECT.DATASET.view_ddl_snapshot`
  WHERE snapshot_date = @before_date
),
after_side AS (
  SELECT FORMAT('%s.%s.%s', table_catalog, table_schema, table_name) AS view_key, ddl
  FROM `PROJECT.DATASET.view_ddl_snapshot`
  WHERE snapshot_date = @after_date
)
SELECT
  COALESCE(b.view_key, a.view_key) AS view_key,
  IFNULL(b.ddl, '')                AS before_ddl,
  IFNULL(a.ddl, '')                AS after_ddl
FROM before_side b
FULL OUTER JOIN after_side a USING (view_key);
```

スナップショット表の作り方は [`../ddl_diff.sql`](../ddl_diff.sql) の冒頭を参照。
比較日をレポートから切り替えたい場合は、Looker Studio の**パラメータ**を
`@before_date` / `@after_date` にバインドする。

## Looker Studio での設定

1. レポート編集画面 → **[追加] → [コミュニティ ビジュアリゼーションとコンポーネント]**
   → **[+ 独自の作成物を追加]** に `gs://my-bucket/viz/ddl-diff` を貼り付ける
2. フィールドを割り当てる
   | 設定項目 | 割り当てるフィールド | 必須 |
   |---|---|---|
   | View 名（見出し用） | `view_key` | 任意 |
   | 変更前 DDL | `before_ddl` | 必須 |
   | 変更後 DDL | `after_ddl` | 必須 |
3. 変更のあった View だけ出したいならフィルタで `before_ddl != after_ddl` を条件にする
4. 特定の View だけ見たいならコントロール（プルダウン）で `view_key` を絞る

### スタイル設定

| 項目 | 既定 | 内容 |
|---|---|---|
| 左ペインの見出し / 右ペインの見出し | `before` / `after` | 日付などを入れると差異部分がハイライトされる |
| 表示する View 数の上限 | 10 | 超えた分は警告を出して切り捨てる |
| フォント / フォントサイズ / 行の高さ | Roboto Mono / 12px / 1.35 | |
| 変更前・変更後ペインの基本色 | `#E17B7B` / `#93AE68` | 差分行・差分文字・カラーバー・ヘッダが連動する |
| 差分行の背景の濃さ / 差分文字の濃さ | 0.30 / 0.55 | |
| SQL シンタックス（予約語 / リテラル / コメント） | `#CF222E` / `#098658` / `#6E7781` | |

## 制約・注意

- **行数の上限**: LCS は O(旧行数 × 新行数)。約 2000 行 × 2000 行を超えると差分計算を中止して
  案内を表示する（`src/viz.js` の `MAX_CELLS`）。ブラウザ内で走るので上限は保守的にしてある
- **Looker Studio が viz に渡す行数・セル長には上限がある。** 巨大な DDL を大量の View 分
  一度に渡すと切り捨てが起きうるので、まずフィルタで対象を絞る運用を前提にすること。
  実測して足りなければ、DDL を分割格納して `viz.js` 側で結合する形に拡張する
- **外部ネットワークにアクセスできない。** sandbox iframe 内で動くため、CDN もフォントの
  外部読み込みも不可。すべてバンドル済み
- **`innerHTML` の安全性**: `render.js` は HTML エスケープ済みの文字列を出す。加えて
  `innerHTML` で挿入された `<script>` はブラウザ仕様上実行されない
- **`manifest.json` の `devMode` が `true`** になっている。本番運用に移すときは `false` にする
- 組織ポリシーでコミュニティ ビジュアライゼーションが許可されている必要がある

## `lib/` の再同期

`src/lib/diff.js` / `src/lib/render.js` は `diff_html/diff-to-html.zip` の同名ファイルの
コピー。拡張側を更新したら上書きコピーして `npm test` を通すこと（API は
`splitLines` / `build2Way` / `renderFragment2` の 3 つだけ使っている）。
