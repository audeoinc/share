# 次のセッションへの申し送り（2026-10-21 時点）

> **この文書は使い捨てです。** 恒久的な情報（現在地・設計判断・BigQuery の落とし穴・
> 守るべきルール）は [`HANDOFF_BRIEF.md`](HANDOFF_BRIEF.md) にあります。こちらは
> 「2026-10-21 のセッションを閉じた時点で、次に手を動かす人が知っておくべきこと」だけを
> 書いた申し送りで、**中身を消化したら削除してかまいません**。放置して3つめの
> 「真実の在処」になるのが一番困ります。

## 0. 読む順番

```
share/CLAUDE.md            起動時に自動読込（share は複数プロジェクトが同居しているので、まず対象の確認）
lineage/CLAUDE.md          lineage を触るときに自動読込。§7「現在地」にバンドルの sha256 とテスト本数
lineage/docs/HANDOFF_BRIEF.md   §8 未了事項 / §9 守るべきルール / §10 BigQuery の落とし穴
この文書                   いま何が終わっていて、何が手作業で残っているか
```

ローカルで始める場合は、`main` を pull してリポジトリのディレクトリで `claude` を
起動するだけです。`CLAUDE.md` は自動で読み込まれます。

## 1. いま main に入っているもの

リージョン横断レポートの一式が入りました。**まだ BigQuery で一度も動かしていません。**

| ファイル | 役割 |
|---|---|
| `sql/pipeline/14_export_report_tables.sql` | 集約リージョン以外の各リージョンで実行。`EXPORT DATA` 文2本だけ（スクリプトではない）。static テーブル2本を Parquet で集約リージョンのバケットへ |
| `sql/pipeline/15_build_cross_region_report.sql` | 集約リージョン（TKY）で実行。外部テーブル定義 → 検査 → `CLUSTER BY origin_dataset, ...` で UNION して公開 |
| `docs/CROSS_REGION_REPORT.md` | セットアップ、実行順、各検査が何を捕まえるか、残留シャードの扱い |

あわせて 03 STEP 4b の static テーブル2本から、クラスタキーの `origin_project` を外しました
（単一プロジェクトで1値かつフィルタに使わないため、先頭の枠を無駄にしていた）。

**なぜこの構成なのか**を3行でいうと：

- BigQuery のクエリは**単一リージョンしか読めない**ので、Looker Studio でのブレンドをやめるには行を物理的に集める必要がある
- GCS を経由するのは**集約リージョン以外**だけ。TKY 自身のテーブルは 15 がローカルで読む
- 集約テーブルは**別に持つ**（03 が `CREATE OR REPLACE` でローカル行だけから作り直すので、同じテーブルに相乗りすると翌日消える）

詳細と判断の根拠は `docs/CROSS_REGION_REPORT.md` に全部あります。

## 2. 手作業で残っていること

### 2.1 ブランチ2本の削除

main に完全に含まれていること（独自コミット0件）は確認済みです。**クラウドセッションからは
ref の削除が 403 で拒否される**（`git push --delete` / REST API / GitHub MCP すべて不可）ため、
手元で実行してください。

```bash
git push origin --delete claude/lineage-project-resume-tqwrp9 claude/viewlgc-resume
```

GitHub の Branches 画面からでも消せます。

### 2.2 Cloud Run の `APP_PASSWORD`（lineage とは無関係）

`agent/proposal-sample` のデモアプリの Basic 認証パスワードが、`.claude/settings.local.json`
経由で git 履歴に入っていました。ファイルは追跡対象から外しましたが**履歴には残ります**。
パスワードを変えれば履歴の値は無意味になります。未対応なら先に片付けてください。

## 3. 最優先の未了事項

`HANDOFF_BRIEF.md` §8.3 / §8.4 と同じ内容です。**サイズ測定（§8.4）が先**で、それが
いくつかの判断を決めます。

### 3.1 まずサイズを測る

```sql
SELECT table_name,
       ROUND(SUM(total_logical_bytes)/1048576, 1) AS mb,
       SUM(row_count) AS rows
FROM `project_id.lineage_repository.INFORMATION_SCHEMA.TABLE_STORAGE`
WHERE table_name LIKE '%column_usage_impact%'
   OR table_name LIKE '%object_dependency%'
GROUP BY table_name
```

既定の `static_tables_include_usage_sql = TRUE` だと、`usage_definition_text` /
`usage_definition_html` が**対象オブジェクトの SQL 全文を行ごとに複製**します。ここが
サイズの支配要因で、export の転送量・GCS 費用・集約テーブルのサイズ・1ファイルに収まるかの
判定、**すべてに効きます**。レポートで SQL 本文を表示していないなら `FALSE` に。

### 3.2 14 / 15 の初回実行で確認する3点

1. **シャード数**（初回 export 後に `gsutil ls`）。1テーブル1ファイルに収まるなら、14 の URI を
   `*` なしの単一ファイル形式（ファイル内にコメントで併記済み）へ切り替える。残留シャードが
   原理的に起こらなくなる。**SQL では GCS のファイルを削除できない**ので、これが唯一の
   「作らない」手段
2. **外部テーブル越しの `MAX(updated_at)` / `COUNT(DISTINCT updated_at)`**（Parquet の
   TIMESTAMP 変換）。15 の残留シャード無害化が**ここに依存しています**
3. **`10` のレポート9の `labels` 展開**。ビューでは `labels` が NULL になるはずで、
   `dag_id` / `task_id` が想定どおり NULL で返るか

### 3.3 `10` のレポート9・10

新規オブジェクトの実物一覧と、次の実行が解析する一覧。**これも実機未実行**です。

## 4. 気をつけること（詳細は HANDOFF_BRIEF §9）

- **識別子の匿名化を維持**。実プロジェクト名・データセット名・リポジトリ名・ブランチ名は
  書かない（`project_id` / `dataset` を使う）。この一式は別プロジェクトへ移して使うため
- **1 変更 = 実装 ＋ 番号付き回帰テスト ＋ CHANGELOG 追記**
- **エンジンを変えたらバンドル再ビルド → `release_manifest.json` 更新 → GCS 差し替え**
- UDF の署名を変えるときは `javascript/scripts/lib/deployment_udf_sql.js` を直す
  （忘れると `test_v1_5_0_080` が落ちる。経緯は `docs/UDF_DEPLOYMENT_CONSISTENCY.md`）
- **リリース ZIP はコミットしない**。`npm run build:everything` で生成する

## 5. 補足：SQL の静的検査について

report スクリプトはオフラインで実行できないため回帰テストがありません。14 / 15 は代わりに
機械的な照合を通しています（`FORMAT` のプレースホルダ数と引数数、`EXECUTE IMMEDIATE ...
USING` の名前付きパラメータの対応、`DECLARE` の位置、`''` の誤用）。

**この検査は単一ブロックのスクリプトにしか通用しません。** 03 のように入れ子 `BEGIN` や
テンプレートの文字列連結、`ARRAY<STRUCT<a, b>>` 型を含むものには誤検出が大量に出ます。
検査スクリプト自体は一時ファイルだったのでリポジトリには入っていません。必要なら作り直して
ください（Node 製にするならプロジェクトのツールチェーンに揃います）。
