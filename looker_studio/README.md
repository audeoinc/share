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

### A. コミュニティ ビジュアライゼーション → 実装済みだが**公開バケットが必須**

> **公開バケットが禁止されている組織では使えない。** Looker Studio は
> `getThirdPartyScript` というサーバー側フェッチャで JS を取得し、閲覧者の認証情報を
> 持たないため、ドメイン限定 IAM では 403 になる。公式ドキュメントにも
> "all of your resources must be publicly available" と明記されている。
> その場合は上の表グラフ方式（`ddl_diff.sql` セクション 4 のカスタムクエリ）を使う。

実装は [`ddl_diff_viz/`](./ddl_diff_viz/) にある。

`dscc` で自作のビジュアライゼーションを作る方式。**行内の単語単位ハイライトまで
GitHub と同等**の表示ができる。`diff_html/` の VS Code 拡張の差分ロジックを
そのままベンダリングしてあるので、diff2html を別途持ち込む必要はない。

- BigQuery 側は **`(key, ddl)` の 2 列だけ**。レポートのプルダウンで key を 2 つ選ぶと、
  その 2 件の DDL がビジュアライゼーションに渡り、ブラウザ内で差分を計算する
- HTML を事前生成して格納しない（インライン CSS の HTML は DDL の約 21 倍に膨らむ一方、
  レンダリングは 20〜80ms しかかからない）
- ビジュアルは sandbox iframe 内で動くため**外部ネットワーク不可**。ライブラリは同梱必須
- GCS バケットへのデプロイが必要で、**バケットは `allUsers` 公開が必須**
  （Looker Studio がサーバー側で JS を取得するため。ドメイン限定だと 403 になる）。
  公開されるのは viz のコードだけで、DDL は GCS を通らない
- 組織ポリシーでコミュニティ ビジュアライゼーションが許可されている必要がある

セットアップ手順は [`ddl_diff_viz/README.md`](./ddl_diff_viz/README.md) を参照。
**この方式を使う場合、本ディレクトリの `ddl_diff.sql` の UDF は不要**
（必要なのは `(key, ddl)` の 2 列だけ）。

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

| | 実装コスト | 見た目 | 動的切替 | 公開バケット |
|---|---|---|---|---|
| **Templated Record + UDF（[`templated_record/`](./templated_record/)）** | **小** | **GitHub 同等（単語単位）** | ○ | **不要** |
| 表グラフ + カスタムクエリ（`ddl_diff.sql`） | 小 | 行単位まで | ○ | 不要 |
| 自作コミュニティ ビジュアライゼーション（`ddl_diff_viz/`） | 実装済み | GitHub 同等（単語単位） | ○ | **必須** |
| Cloud Run + HYPERLINK | 中 | GitHub 同等（別タブ） | ○ | 不要 |
| URL 埋め込み | 小 | GitHub 同等 | × | 不要 |

**推奨は [`templated_record/`](./templated_record/)。** ギャラリー掲載の
[Templated Record](https://lookerstudio.google.com/reporting/fd0db9a6-2d6b-443a-adbc-f6a7c7a285a7/page/GUgQB)
は公開元がホストしているのでバケットを公開する必要がなく、HTML を BigQuery の UDF で
生成して渡すだけで単語単位ハイライトまで再現できる。自作ビジュアライゼーション
（`ddl_diff_viz/`）は公開バケットが必須なので、それが禁止の組織では使えない。
