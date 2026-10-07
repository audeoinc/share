# UDF 配布とソースの整合性（監査記録と恒久ルール）

> **この文書の目的**：「配布している UDF とソースが食い違っている」という指摘を受けて
> ZIP 一式を監査した結果と、その修正内容、再発防止の仕組み、検証手順をまとめたもの。
> 作業を引き継ぐ場合は §1（結論）→ §5（検証手順）だけ読めば足りる。

---

## 1. 結論

**指摘は正しかった。** バンドル本体（`javascript/dist/lineage_udf_bundle.js`）はソースと
完全一致していたが、**リリースパイプラインが生成するデプロイ DDL がエンジンの API と
食い違っていた**。`--deploy` を実行すると稼働中の `lnge_analyze_json` を壊れた関数に
置き換えてしまう状態だった。あわせて計 5 件の不整合を修正済み。

修正後の状態：

| 確認項目 | 結果 |
|---|---|
| `dist/` のバンドルを `src/` から再ビルド | 1 バイトも変わらない（決定論的） |
| `release_manifest.json` の `sha256` / `size_bytes` と実ファイル | 一致 |
| ZIP と作業ツリー | **byte-identical**（`release_manifest.json` 含め差分ゼロ） |
| `test:release` / ゴールデン | 61 本 PASS / 48 ケース PASS |
| UDF の署名を宣言する 4 経路 | 全一致（`test_v1_5_0_080` が機械的に保証） |

残る未検証項目は従来どおり **BigQuery 実機での動作確認**のみ。

---

## 2. 本命の不整合 — 生成 DDL がエンジンに無い関数を呼んでいた

`javascript/scripts/build_everything.js` の `writeDeploymentSql()` が、デプロイ用 DDL を
ベタ書きで組み立てていて 2 点ずれていた。

| | 生成していた DDL | ソースの実体 |
|---|---|---|
| パラメータ | 3 個（`sql_text` / `physical_columns_json` / `options_json`） | **4 個**（＋ `export_metadata_json`） |
| 呼び出す関数 | `LineageEngine.analyzeToJson(...)` | **`analyzeLineageForBigQuery(...)`** |

`analyzeToJson` は `javascript/src` にも `dist/` にも**存在しない**。唯一の出現箇所が
この生成コードの 1 行だった。一方、他の 3 経路はすべて 4 引数の
`analyzeLineageForBigQuery` で一致している。

- `sql/setup/01_setup_lineage_environment.sql`（初期構築）
- `sql/bigquery/create_persistent_lineage_udf.sql`（バンドル差し替え時の再配備）
- `sql/pipeline/03_run_daily_lineage_pipeline.sql`（`__UDF__` 呼び出し 2 か所）

**実害**：`npm run build:everything -- --deploy` が `bq query` で 3 引数の関数を
`CREATE OR REPLACE` する。03 は 4 引数で呼ぶので全解析が
`No matching signature` で落ちる。しかも**ビルド自体は成功と報告する**。

**気づかれなかった理由**：ずれが「SQL のテキスト」と「JavaScript の API」の間にあり、
**両者を突き合わせるテストが 1 本も無かった**。ユニットテストは JS だけ、SQL 側は
BigQuery でしか動かないので、その境界が検査の死角になっていた。

### 修正

署名の置き場所を **`javascript/scripts/lib/deployment_udf_sql.js` 1 か所**に集約した。

```js
const { UDF_PARAMETER_NAMES, UDF_ENTRY_POINT, buildPersistentUdfSql } =
  require("./lib/deployment_udf_sql");
```

- `UDF_PARAMETER_NAMES` … `["sql_text","physical_columns_json","options_json","export_metadata_json"]`
- `UDF_ENTRY_POINT` … `"analyzeLineageForBigQuery"`
- `buildPersistentUdfSql({project, dataset, functionName, bundleUri})` … DDL を組む

`writeDeploymentSql()` はこれをレンダリングするだけになった。

---

## 3. 残り 4 件の不整合

### 3.1 `release_config.example.json` の関数名が規約違反かつ呼ばれない名前

`"bigquery_function": "analyze_lineage"` だった。必須の `lnge_` 命名規則に反し、かつ
03 が組み立てる名前は `<prefix>lnge_analyze_json<suffix>` なので、**デプロイ先の関数名が
パイプラインの呼び先と一致しない**。`lnge_analyze_json` に修正。

併せて、ローダー（`loadConfig`）が一度も読んでいない死んだキー
`repository_validation_sql` を削除した。

### 3.2 `release_manifest.json` が ZIP と手元で食い違う構造だった

ビルドは manifest を**ステージしたリリースディレクトリにしか書いていなかった**。
リポジトリ直下の `release_manifest.json` は手で維持する前提で、実際に `generated_at` が
1 日ずれていた。

これは「エンジンを再ビルドしたのに manifest の `sha256` が古いまま」が**静かに起きうる
構造そのもの**なので、**両方に同一バイトを書く**ようにした（`writeManifest()`）。

### 3.3 `deployment.status` が結果ではなく意図を記録していた

`manifest.deployment.status = "DEPLOYED"` の代入が**ファイル書き込みより後**にあり、
デプロイが成功しても ZIP には `"PENDING"` が入っていた。

ステップ順を組み替えた：

```
stage → (deploy なら) バンドル upload + bq デプロイ → manifest 書き込み
      → ZIP 作成 → (deploy なら) ZIP upload
```

これで ZIP 内の manifest が**実際の結果**を持ち、手元のコピーとも一致する。

### 3.4 `CLAUDE.md` §7 の記録が古く、配布バンドルと矛盾していた

| 記録されていた値 | 実際 |
|---|---|
| `sha256 = ad18b4bc…` / `461888` bytes | `eecd0bc8…` / `478961` bytes |
| `test:release` 52 本 | 60 本（現在 61 本） |

`CLAUDE.md` はセッション開始時に自動読込されるので、**どの Agent も最初にこの古い
ハッシュを見る**。「配布とソースが食い違う」と判断するには十分な材料だった。

§7 は**現行値として保つ 3 項目**（バンドル・テスト本数・実測性能）だけに絞り、変更内容の
記述は `CHANGELOG.md` / `docs/HANDOFF_BRIEF.md` を見る形にした（古くなる元凶がそこ
だったため）。`docs/SESSION_HANDOFF.md` §0.1 の移行前の数値は「当時の値」と明記した。

---

## 4. 再発防止 — `test_v1_5_0_080`

`javascript/test/test_v1_5_0_080.js` が、**署名を読む 4 者すべて**を
`scripts/lib/deployment_udf_sql.js` に突き合わせる。

1. バンドルが `analyzeLineageForBigQuery` を export していて、引数が 4 個か
   （`Function.length`）
2. 生成 DDL のパラメータ名・順序・エントリポイント（`analyzeToJson` が出てこないこと）
3. 手書き SQL 2 本（01 / 再配備ヘルパ）から**パラメータリストを実際にパースして**照合
   — エントリポイントの呼び出し位置から直前の `CREATE OR REPLACE FUNCTION` を逆引きし、
   括弧対応でパラメータを切り出す（01 は複数の関数を作るため）
4. 03 の `__UDF__` 各呼び出しが**何引数渡しているかを括弧対応で数えて**照合

引数を 3 個に戻すと落ちることを確認してある（偽陽性テストでないことの確認）。

**守るべきこと**：UDF の署名を変える場合は
`javascript/scripts/lib/deployment_udf_sql.js` を直し、01 と再配備ヘルパと 03 を追随
させる。どれかを忘れると `test_v1_5_0_080` が落ちる。

---

## 5. 検証手順（引き継ぎ先での確認）

```
cd javascript
npm test                  # build → bundle 検証 → usage-html UDF 同期 → 回帰 61 本
node test/test_v1_5_0_003.js   # ゴールデン 48 ケース
npm run build:everything       # 上記 ＋ リリース ZIP の作り直し
```

期待値：

- `test:release` **61 本 PASS** / ゴールデン **48 ケース PASS**
- `sha256sum javascript/dist/lineage_udf_bundle.js` が
  `release_manifest.json` の `bundle.sha256` と一致
- ZIP を展開して作業ツリーと `diff -r` → **差分ゼロ**

ZIP と作業ツリーの一致確認（手元で一度やっておくと安心）：

```
unzip -q release/lineage_v<version>.zip -d /tmp/zipcheck
diff -r --brief <このツリー> /tmp/zipcheck/lineage_v<version>
```

---

## 6. 問題が無かったことを確認した項目

- `dist/lineage_udf_bundle.js` を `src/` から再ビルドして**1 バイトも変わらない**
  （配布バンドル自体はソースと完全一致）
- `verify_bundle.js` PASS（公開 API とスモーク解析）
- usage-html UDF が `src/html/usage_sql_html.js` と同期（`--check` PASS）
- `release_manifest.json` の `golden_case_count: 48` と実フィクスチャ数が一致
- `javascript/VERSION` / `javascript/package.json` / `release_manifest.json` の
  バージョン表記が全部一致
- `CLAUDE.md` §1 の「24 ソース」は `scripts/build_udf.js` のリストと一致
  （`src/` の 25 本目は別 UDF 用の `src/html/usage_sql_html.js` なので対象外）
- リリース名 `lineage_v<version>` は `javascript/VERSION` 由来で、リポジトリ名や
  環境固有の情報を含まない

---

## 7. 関連

- 変更の詳細は `CHANGELOG.md` の `1.5.0-032` 冒頭
- 全体の現在地・設計判断・未了事項は `docs/HANDOFF_BRIEF.md`
- バンドルのビルド手順は `docs/UDF_BUNDLE_BUILD_PROCESS.md`
