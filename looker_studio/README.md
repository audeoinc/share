# Looker Studio で View の SQL を見せる

BigQuery の View の定義を Looker Studio 上で読めるようにするための仕組みが
4 つ入っています。**用途が違うので、先にどれを見るかを決めてください。**

## どれを見ればよいか

| 入っているもの | 何をするもの | 状態 |
|---|---|---|
| **[`view_groups/`](./view_groups/)** | **suffix 違いの View を base ごとに束ね、ロジックが何通りあるかを見せる。** note / カラム定義 / 参照関係 / ロジック差分 / SQL の 5 タブのカードを日次で作り置きする | **これが本体。運用中** |
| [`ddl_diff_viz/`](./ddl_diff_viz/) | 自作のコミュニティ ビジュアライゼーション。**この方式は採っていない**（GCS バケットの一般公開が必須だが使えないため）。**ただし消せない** ― 下記 | 記録として残す |

### `ddl_diff_viz/` は消せない

採らなかった方式ですが、**`view_groups` のビルド依存**になっています。

```
view_groups/build_udf.mjs  ← ddl_diff_viz/src/lib/diff.js    を UDF に同梱
                           ← ddl_diff_viz/src/lib/render.js  を同じく同梱
                           ← ddl_diff_viz/package.json       から esbuild を引く
```

行単位・語単位の差分を計算する部分（`src/lib/`）は、方式に関係なく使える資産
なので、`view_groups` がそのままベンダリングしています。**`src/lib/` と
`package.json` は動かさないこと。** 残りはコミュニティ ビジュアライゼーション
としての実装と、その検証の記録です。

### 消したもの

2 者比較（**2 つの DDL を人が選んで突き合わせる**形）の試作を 3 つ置いていま
したが、`view_groups` に引き継いで役目を終えたので消しました。比べる 2 本を人が
選ぶ必要があり、**選ばなかった組み合わせは見えない**のが本質的な限界でした。

| 消したもの | 何だったか |
|---|---|
| `ddl_diff.sql` | 表グラフ＋条件付き書式で行単位の差分を見せる。初期の検討 |
| `templated_record/` | Templated Record に HTML を渡す最小の例。`view_groups` の前身 |
| `ddl_diff_viz/release/` | GCS に手で置くためのビルド出力（`npm run release` で再生成できる） |

**1 つだけ引き取ってあります。** `templated_record/samples/07_radio_tabs_test.html`
は「Templated Record の中で **radio + `:checked` だけのタブが実機で動く**」ことを
確かめた実験で、`view_groups` のタブはすべてこれを根拠にしています
（JavaScript が動かないため）。`view_groups/radio_tabs_test.html` に移しました。

### `view_groups/` から読むもの

| 資料 | 誰が読むか |
|---|---|
| [`view_groups/introduction.md`](./view_groups/introduction.md) | 導入を検討する人。背景・効果・必要なもの |
| [`view_groups/DEPLOY.md`](./view_groups/DEPLOY.md) | **入れる人。何もない状態から動くレポートまでの順路** |
| [`view_groups/usage.md`](./view_groups/usage.md) | レポートを見る人。使い方とデータの見方 |
| [`view_groups/README.md`](./view_groups/README.md) | 作る人・直す人。仕組みと設定 |

---
