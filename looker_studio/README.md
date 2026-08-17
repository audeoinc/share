# Looker Studio で View DDL の差分を GitHub compare 風に表示する

2 つのデータに格納された View の DDL を突き合わせて、GitHub の compare 画面のような
行単位の差分を Looker Studio 上で見せるための手順とクエリ。

## 前提: 差分計算は Looker Studio ではできない

Looker Studio の計算フィールドには**配列・ループ・行分割（SPLIT/UNNEST 相当）がない**ため、
2 つの長い文字列を行単位に割って突き合わせる、という処理は書けない。
データ ソースの「統合（blend）」でも同じ。

したがって構成は必ずこうなる:

```
BigQuery                          Looker Studio
─────────────────────────────     ──────────────────────────────
DDL(旧) ┐                          表グラフ
        ├→ 行単位 diff テーブル →   + 条件付き書式（緑/赤）
DDL(新) ┘   (op, 行番号, 行文字列)   + ページ フィルタ
```

差分の「計算」を BigQuery に寄せてしまえば、Looker Studio 側は
「行の色を塗るだけ」になり、見た目は GitHub にかなり近づけられる。

---

## 手順

### 1. BigQuery 側

[`ddl_diff.sql`](./ddl_diff.sql) を上から実行する。`PROJECT.DATASET` は自環境に置換。

- `DIFF_LINES` … 行単位の LCS 差分を返す JavaScript UDF（git diff と同じ考え方）
- `v_view_ddl_diff_split` … 左=旧 / 右=新 の 2 ペイン（GitHub の Split view）
- `v_view_ddl_diff_unified` … 1 カラム（GitHub の Unified view）
- `v_view_ddl_diff_summary` … `+12 / −5` のようなサマリ

出力はこういう形になる:

| seq | op | left_no | left_line | right_no | right_line |
|----:|----|--------:|-----------|---------:|------------|
| 3 | `=` | 3 | `  a,` | 3 | `  a,` |
| 4 | `~` | 4 | `  b,` | 4 | `  b2,` |
| 6 | `+` | | | 6 | `  d` |
| 8 | `-` | 8 | `WHERE x = 1` | | |

比較したい 2 つのデータは `v_view_ddl_diff_split` の `before_side` / `after_side` の
CTE を差し替えるだけ。同じスナップショット表の 2 日付でも、別々のテーブルでもよい。

> 運用では VIEW のままにせず、スケジュールドクエリで**テーブルに materialize** すること。
> VIEW のままだと Looker Studio の操作（フィルタ・ページ送り）のたびに UDF が走る。

### 2. Looker Studio 側

**表グラフを diff ビューアーに仕立てる**

1. データソース = 上で作ったテーブル。グラフは **表**。
2. ディメンション: `left_no`, `left_line`, `right_no`, `right_line`
   （Unified なら `lineno`, `line`）。指標は**なし**（「指標なし」にする）。
3. **並べ替え: `seq` 昇順**。`seq` はグラフに出さなくてもソートには使える。
4. スタイル タブで:
   - 「行番号を表示」オフ、「ページあたりの行数」を最大に、「ヘッダーを表示」は任意
   - フォントは **Roboto Mono** など等幅を選ぶ
   - 「セル内で折り返す」をオン（長い行が切れないように）
   - 表の枠線・縞模様はオフにすると diff らしくなる
5. **条件付き書式**（GitHub と同じ配色）:

   | 条件 | 適用先 | 背景色 |
   |------|--------|--------|
   | `op` = `+` | 行全体 | `#E6FFEC` |
   | `op` = `-` | 行全体 | `#FFEBE9` |
   | `op` = `~` | 行全体 | `#FFF8C5` |

   `op` はグラフのディメンションに入れなくても、条件付き書式の条件には使える。
   Split view で左右を別色にしたい場合は、`left_line` / `right_line` の
   単一列に対する書式ルールを分けて設定する。

6. **変更箇所だけ表示**（GitHub の折りたたみ相当）:
   `near_change_3 = true` をフィルタに追加する。前後 3 行のコンテキスト付きで
   変更行だけが残る。

7. **View の切り替え**: `view_key` をプルダウン（コントロール → プルダウン リスト）にする。
   `v_view_ddl_diff_summary` をスコアカード／一覧表にして、
   `change_label`（`+12 / −5`）や `has_change` を並べると GitHub の
   Files changed ヘッダーのようになる。

---

## この方法の限界

- **文字単位のハイライト**はできない。Looker Studio の表セルは装飾できるが、
  セル内の一部の文字だけ色を変えることはできないので、`~`（変更行）は
  行全体が黄色く光るだけになる。GitHub の「単語単位の赤/緑」は再現不可。
- **インデント**は素直に出すと崩れる。`ddl_diff.sql` では行頭の半角スペースを
  NBSP (`CHR(160)`) に置換して回避している。タブは UDF 側で 4 スペースに展開済み。
- **行数**が多いと表のページングが効いて一覧性が落ちる。`near_change_3` フィルタ併用が前提。
- UDF は O(旧行数 × 新行数)。`ddl_diff.sql` では約 2000 行 × 2000 行で打ち切って
  `op = '!'` の 1 行を返すようにしてある。

---

## 見た目を GitHub そのものにしたい場合の代替案

### A. コミュニティ ビジュアライゼーション（本命だが工数大）

Looker Studio は `dscc`（Community Component）で自作の JS ビジュアルを作れる。
ここに [diff2html](https://diff2html.xyz/) / [jsdiff](https://github.com/kpdecker/diff) を
バンドルすれば、side-by-side ハイライトも文字単位の差分も**GitHub とほぼ同じ**表示にできる。

- `@google/dscc-gen` で雛形 → GCS バケットにデプロイ → レポートで manifest パスを指定
- ビジュアルは sandbox iframe 内で動くため**外部ネットワーク不可**。ライブラリは同梱必須
- 組織ポリシーでコミュニティ ビジュアライゼーションが許可されている必要がある
- 渡すデータは「DDL 全文 2 つ」でもよいが、フィールド長の制約を避けるなら
  行分割済みのテーブルを渡して JS 側で結合するのが安全

### B. 外部ページへリンクする（工数小・現実的）

差分 HTML を返す Cloud Run（`/diff?view=xxx&from=...&to=...`）を用意し、
Looker Studio の表に計算フィールドでリンクを出す:

```
HYPERLINK(CONCAT("https://<cloud-run>/diff?view=", view_key), "差分を見る")
```

クリックで別タブに完全な diff2html が開く。
`diff_html/` の VS Code 拡張が生成しているのと同じ HTML を、
サーバー側で生成して返す形にすれば資産を流用できる。

> なお Looker Studio の「URL を埋め込む」コンポーネントは**固定 URL しか指定できず、
> レポートのパラメータで URL を組み立てられない**ので、View ごとに切り替える用途には使えない。
> 埋め込みで済むのは「常に同じ 1 つの差分ページを見せる」場合だけ。

### C. まとめ

| | 実装コスト | 見た目 | 動的切替 |
|---|---|---|---|
| 表グラフ + 条件付き書式（本手順） | 小 | 行単位まで | ○ |
| コミュニティ ビジュアライゼーション | 大 | GitHub 同等 | ○ |
| Cloud Run + HYPERLINK | 中 | GitHub 同等（別タブ） | ○ |
| URL 埋め込み | 小 | GitHub 同等 | × |
