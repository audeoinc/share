# SESSION_HANDOFF — 1.5.0-032 の意思決定と経緯

このドキュメントは、対話セッションで行った設計判断とその「理由」を、後続の
Claude Code セッション（会話の記憶を持たない）へ引き継ぐためのものです。各項目の
「何を・なぜ」を残しています。実装の要約は `CHANGELOG.md`、規約は `CLAUDE.md` /
`docs/DEVELOPMENT_GUIDE.md` を参照してください。

---

## 0. 直近セッションからの引き継ぎ（リポジトリ移行用・2026-08-22 時点）

> **目的**：本ソースの管理リポジトリを別リポジトリへ移すため、次セッションが迷わず
> 続けられるよう現状を1か所にまとめる。以降の §1〜 は 1.5.0-032 の設計経緯（履歴）で、
> 一部に**古い変数名**が残る（下記「命名の変更」を最優先で参照）。

### 0.1 いまの状態（事実）

> **更新（2026-08-22・新リポジトリでの再開セッション）**
> - リポジトリ移行は**完了**。現行は `audeoinc/share` の `lineage/`、作業ブランチ
>   `claude/lineage-project-resume-tqwrp9`。以下 0.1 の「旧リポジトリ／旧ブランチ」は
>   移行前の記録として読むこと。
> - 移行後の健全性確認は実施済み（`npm test` と `node test/test_v1_5_0_003.js` が
>   記載どおり再現）。
> - **本セッションで 1 件修正**：`WITH cte AS (...) (SELECT ...)`（CTE の後ろの
>   メインQueryが括弧で包まれた形）の「トップレベルのSELECT Clauseが見つかりません」。
>   `query_parser.js` に main-query の括弧剥がしを追加、テスト `test_v1_5_0_073`。
>   → 現在のバンドル: `sha256 = f448d53c3e3b98aba209d0f0458c54e08a1c6fd20e7f724e21145d811bccacb0`、
>   `463531` bytes。
> - **本セッションで 2 件目の修正**：`(A INTERSECT DISTINCT B) EXCEPT DISTINCT C` のように
>   **括弧付き branch が自身のセット演算を含む**形の
>   "FromParser: JOIN was expected, but found ..."。括弧を剥がす際に
>   `disableSetOperations` を引き継いでいたのが原因（演算子の種類には非依存）。
>   テスト `test_v1_5_0_074`。
>   → 現在のバンドル: `sha256 = d7992396d38f568b6d30a44ac7d75183f4563e0f2c22f867a9d7e87d8bee5372`、
>   `465176` bytes。`test:release` **54 本 PASS** / ゴールデン 48 ケース PASS。
>   **エンジン変更のため GCS 再アップロードが必要**。
> - **本ドキュメントは §4.20 までしか追随していない**。§0.7 を参照。

- バージョン: **1.5.0-032**。作業ブランチ: `claude/direct-file-visibility-check-6qztqm`
  （旧リポジトリ `audeoinc/audeo-share`、ディレクトリ `lineage/`）。
- バンドル: `javascript/dist/lineage_udf_bundle.js`
  `sha256 = ad18b4bc5a015e9d831900d5ca6edfde4043b3c5ccb9fc71a6940e0e24ad00cf`、`461888` bytes。
- テスト: `test:release` 52 本 PASS / ゴールデン（`test_v1_5_0_003`）48 ケース PASS。
- 作業ツリーはクリーン（未コミットなし）。全コミットは上記ブランチに push 済み。
- **BigQuery 実機での実行検証は未実施**（このセッションはオフライン。ユーザーが実機で
  逐次確認しながら不具合を報告→修正、を繰り返した）。

### 0.2 リポジトリ移行時の作業（次セッションの最初にやること）
1. 新リポジトリに `lineage/` 一式（`javascript/`・`sql/`・`docs/`・`CLAUDE.md`・
   `CHANGELOG.md`・`release_manifest.json` 等）を配置。**`javascript/dist/` の
   バンドルも必ず含める**（`release_manifest.json` の sha256/size と一致していること）。
2. 移行後にまず健全性確認：`cd javascript && npm test`（build→verify:bundle→test:release）
   と `node test/test_v1_5_0_003.js`。上記の PASS 本数・sha256 を再現できれば移行成功。
3. `CLAUDE.md` はセッション開始時に自動読込される運用（新リポジトリでも同じ場所に置く）。
4. 新しいブランチ運用・PR 先は新リポジトリの規約に合わせる。旧ブランチ名に依存しない。

### 0.3 デプロイ時の必須注意（エンジンを変更しているため）
- 本セッションで **JS エンジン（`javascript/src`）を変更**した。デプロイ時は
  **GCS 上の `lineage_udf_bundle.js` を再アップロード**すること（`sql/` のみの変更なら
  不要だが、今回はバンドルが変わっている）。GCS URI は 01/04 の `*_udf_library_uri`。
- エンジン変更手順（厳守）: `src/` 変更 → `node scripts/build_udf.js` → 全テスト →
  `release_manifest.json` の sha256/size 更新 → GCS 再アップロード。

### 0.4 このセッションで入れた変更（新しい順・各1行）
- `e829e2c` 無型 STRUCT のフィールド別名 `STRUCT(expr AS name,...)` を式パーサで消費
  （UNNEST/WHERE 等の非復旧位置で `expected ")" but found "AS"` になっていた DAG SQL を修正）。
  併せて式パーサのエラーに `at line/column (token_seq) near: …` を付与（診断で位置特定可能に）。
  test 071/072。
- `0d44f65` FROM サブクエリが `WITH` / セット演算（`INTERSECT DISTINCT` 等）で始まる形を許可。test 070。
- `db02ef4` 03 の列メタ union の `SELECT *` を明示列に変更（データセット毎に
  INFORMATION_SCHEMA.COLUMNS の列数が異なり UNION ALL 不一致になる問題）。SQL のみ。
- `3972557` `{project_token}` を UDF ライブラリ URI でも置換（01/04 の抜け漏れ修正）＋
  dataset 名/URI に残留プレースホルダ・不正文字の早期 ASSERT を全スクリプトに追加。
- `3596427` 01 の setup summary（step 7）に `project_id` / `project_token` を表示。
- `0774298` 全スクリプトの `[A]` グループ順を 03 に統一＋命名ノブ（project_token/udf prefix/suffix）を `[A]` へ。
- `52c12e6` **03 の対象フィルタを2系統へ統合**（レジストリ＝解析対象）。下記「命名の変更」参照。
- `aa41e98` 自動取得の `default_project_id`（01/04 は `bootstrap_default_project_id`）の DECLARE を `[A]`→`[B]` へ。
- `117cc84`/`54ae2b4` `[A]` を「グループ見出し＋Variable notes」構成に統一（全スクリプト）。
- `26c626d`/`1ab9054` `{project_token}` 置換の導入、UDF 名 prefix/suffix 化、project_id 自動取得（SCHEMATA）。
- `c79d09f`/`ec5ce92` 全テーブル/ビュー/UDF に `lnge_` prefix、ソース zip 更新。

### 0.5 命名の変更（重要・§3 等の古い記述を上書きする）
- 03 の**対象フィルタは2系統に統合済み**。以前の
  `target_dataset_include/exclude_patterns`（走査範囲）と
  `registry_exclude_object/dataset_patterns`（収集除外）は**廃止**。現在は:
  - `analysis_include/exclude_dataset_patterns` … dataset スコープ（View 走査範囲＋
    生成テーブルの dataset ゲート）
  - `analysis_include/exclude_object_patterns` … object 名フィルタ（**収集時**に適用）
  - 両者は STEP1/STEP2（収集）で適用し、通ったものだけがレジストリ＝解析対象。除外分は
    登録も変更追跡もされない（orphan cleanup が deactivate）。解析段でのフィルタ再適用は撤去。
  - `source_project_filters` は別軸（参照される物理テーブルの schema 取得範囲）で不変。
  - 09 のレポートスコープも `target_dataset_*` → `analysis_*_dataset` に改名。
- したがって **本ドキュメント §3 の `target_dataset_*` / `registry_exclude_*` の記述は歴史的経緯**
  として読むこと（現行の変数は上記）。CLAUDE.md §6 は最新に更新済み。

### 0.6 既知のパース・ギャップの直し方（DAG 生成 SQL 対応のパターン）
実機の DAG ジョブ SQL で未対応構文に当たると、03 の **source-discovery パス**は既定
（strict/throw）なので解析が落ちる（解析パスの non-strict 復旧とは別物）。今回対応したのは:
1. `FROM (WITH … / (…) UNION|INTERSECT|EXCEPT …)` → from_parser のサブクエリ入口ガード緩和。
2. 無型 `STRUCT(expr AS name)` → 式パーサの STRUCT 引数で任意 `AS <name>` を消費。
- 次に別の未対応構文が出たら、まず**式パーサのエラーメッセージ**（`near: …` 付き）で
  箇所を特定 → `javascript/dist` を使った node 再現スクリプトを書く（**options は `"{}"`
  ＝throw モードで再現する。`strict_mode:false` だと復旧して再現しないので注意**）→
  該当 parser を修正 → `test_v1_5_0_0XX` 追加 → 再ビルド → manifest/CHANGELOG 更新。
- 再現の呼び出し例:
  `analyzeLineageForBigQuery(sql, JSON.stringify(cols), "{}", JSON.stringify({analysis_id,view_project,view_dataset,view_name,analyzed_at}))`
  （`cols` は `[{table_name:"ds.t",column_name:"c",field_path:"c"}]` 形式）。

## 1. このバージョンで確定した方針

- **環境識別子の除去**：全ファイルの実名（旧 `audeodb` / `sample_ds` 等）を
  `project_id` / `dataset` に統一。自社環境を特定させないため。以後もこの匿名化を維持する。
- **設定テーブルの廃止**：
  - `lineage_config` テーブルを完全廃止。設定は 03 のパラメータに集約（01 は「初回の
    ブートストラップ準備」に限定され、意味合いが異なるので二重管理を許容）。
  - `lineage_execution_account_config` テーブルを廃止。サービスアカウントは 03 内で
    `scheduled_query_service_accounts` / `dag_service_accounts` として DECLARE 管理。
  - JOBS 抽出条件（lookback、statement types、scheduled query ラベル要否）も 03 の
    パラメータへ。意味のあるノブだけを露出する方針。
- **01 の初期化**：`CREATE TABLE IF NOT EXISTS` → `CREATE OR REPLACE TABLE`。
  スキーマ作成（テーブル用・fn 用の両データセット）は `CREATE SCHEMA` をコメントアウト。

## 2. JOBS 由来 SQL の重複除去（フィンガープリント方式）

背景として 2 パターンあった：(1) DAG が `CREATE TABLE AS SELECT * FROM view` を実行
→ view まで遡りたい（トレーサビリティ維持）。(2) 純粋な `SELECT` が毎回異なる一時
宛先テーブルに書き出される → 解析は 1 回で良い。

- 判断：宛先テーブル基準ではなく **全 SQL をフィンガープリントで一意化し、各 1 回だけ
  解析**する。VIEW は全件解析、JOBS 由来のみこの集約を適用。
- ただし **「出し分け」** を採用（一律集約しない）：永続宛先は宛先ごとに実名のまま保持し
  点(1) の遡りを残す。一時/期限付き宛先はフィンガープリント代表 1 件に集約する。
- **ephemeral 判定**：当初は「宛先が実在するか」で分けたが、SELECT が実在するが
  expiration 付きの一時テーブルに書くケースが persistent 誤判定され重複した。修正後の
  判定は「**宛先が実在し、かつ table expiration が無い**もののみ永続」。それ以外
  （非実在 or expiration 付き）は ephemeral として合成ラベル
  `<target_project>.<ephemeral_object_dataset_label>.fp_<hash>` に集約。
- 実装：`lnge_fingerprint_sql` UDF（01）と `fingerprintSqlForBigQuery`（エンジン）。
  文字列/数値リテラルを `?` に置換し構造だけを比較（リテラル差のみの SQL は同一指紋）。

## 3. フィルタ/リージョンまわりの整理

- ソース/ターゲットのデータセット選択を **すべて正規表現に統一**（LIKE を廃止）。
  `source_project_filters` は `dataset_include_patterns` / `dataset_exclude_patterns`、
  ターゲットは `target_dataset_include_patterns` / `target_dataset_exclude_patterns`。
  空 include=リージョン内全件、空 exclude=除外なし。
- `target_datasets` は明示列挙をやめ、**リージョン + 正規表現**で SCHEMATA を走査して解決。
- `job_region` を環境設定の先頭へ（リポジトリ・ターゲット VIEW・ソースメタデータ・
  JOBS すべてで使う単一リージョン、`@@location` と一致）。
- 名前フィルタは **大文字小文字を無視**（`REGEXP_CONTAINS(LOWER(name), LOWER(pattern))`）。
  以前は name だけ小文字化し pattern はそのままで、大文字パターンが常に外れていた。
- 名前規則による除外フィルタは 2 系統に統一（いずれも object 名の正規表現）：
  `registry_exclude_object_patterns`（登録段で存在ごと除外。VIEW は STEP 1、生成
  TABLE は STEP 2 の destination 名で弾き、レジストリに載せない）と、
  `analysis_include_object_patterns` / `analysis_exclude_object_patterns`（解析段で
  解析だけを制御。レジストリには残す）。宣言順は実行順に合わせ registry を先に置く。
  旧名: `exclude_view_name_patterns` → `registry_exclude_object_patterns`、
  `include/exclude_object_patterns` → `analysis_include/exclude_object_patterns`。
- **データセット版フィルタを追加**（object 名版と並列・非破壊、既定 `[]`）：
  `registry_exclude_dataset_patterns`（登録段。VIEW=object_dataset、生成 TABLE=
  destination_dataset で除外。名前版と OR）と `analysis_include_dataset_patterns` /
  `analysis_exclude_dataset_patterns`（解析段。名前版とは独立の AND ゲート：
  name-include かつ dataset-include を満たし、name-exclude・dataset-exclude の
  いずれにも当たらない object を解析）。マッチは既存同様
  `REGEXP_CONTAINS(LOWER(値), LOWER(pattern))`（大文字小文字無視）。
- 冗長変数の整理：`lnge_render_dynamic_sql` の未使用プレースホルダ `__REPOSITORY__` /
  `__TARGET__` と、それだけのために存在した `target_dataset` スカラーを撤去
  （現在は 8 プレースホルダ / 9 パラメータ）。

## 4. パーサ/リゾルバの機能追加・修正

- **配列要素アクセス**：`arr[SAFE_OFFSET(n)]` / `OFFSET` / `ORDINAL` / `SAFE_ORDINAL` /
  汎用 `[expr]` の後置サブスクリプトをパース対応（位置キーワード自体はリネージを持たず、
  要素値は配列式のソース列へ、添字内の列も捕捉）。テスト `test_v1_5_0_047.js`。
- **修飾あり/なし混在 × `SELECT *` CTE の JOIN（直近・重要）**：
  症状＝`FROM` が `SELECT *` の CTE、`LEFT JOIN` が実テーブル（ともに別名）で、
  本来 `FROM`(CTE) 側の非修飾列が JOIN 側で探され `PHYSICAL_COLUMN_NOT_FOUND`、
  さらに CTE への修飾参照 `x.col` まで `UNRESOLVED_COLUMN` になっていた。
  原因＝`SELECT * FROM 物理表` の CTE は名前解決段階では公開列が「不明」なのに、
  `ColumnResolver#getWildcardExposedColumns` が物理/UNNEST ソースを読み飛ばし、
  公開列「ゼロ（空集合）」と誤認 → CTE が候補ソースから外れ、非修飾列が誤って単独で
  JOIN 側にバインド（候補 1 件確定のため救済処理も不発）。
  修正＝ワイルドカードが列不明のソース（物理/UNNEST/列不明の子スコープ）を取り込む
  場合は空集合ではなく **「不明（null）」を伝播**。CTE が候補として残り、
  `PhysicalColumnResolver` が実メタデータで曖昧性を解消する。テスト `test_v1_5_0_048.js`。

## 4.5 STEP 3 高速化（03 パイプライン）

- **律速の所在**：03 の STEP 3 は「変更オブジェクト 1 件ずつの逐次 `FOR` ループ」で、
  1 件あたり約 20 の `EXECUTE IMMEDIATE`（UDF 2 回＝ソース探索＋本解析、温度テーブル
  作成、DELETE/INSERT/UPDATE/MERGE 多数）を直列実行する。変更 N 件で ~15〜20N ジョブが
  直列に走り、ジョブ起動・スロット取得オーバーヘッド × N が支配的コスト。STEP1/2 は
  増分 lookback で妥当、STEP4 は `WITH RECURSIVE` の 1 発でセットベース済み。
- **② 部分改修（実施済み）**：ソース探索 UDF をループ外へ集約。UDF は行ごとのスカラー
  関数なので、`source_discovery_only` を全変更定義に対して 1 ジョブで実行する温度テーブル
  `changed_definitions_with_discovery` を作り、ループは `target.source_discovery_json` を
  直接読む。UDF 呼び出しがオブジェクト当たり 2 回→1 回、探索の JS UDF 初期化コストは
  実行あたり 1 回に。隔離は維持（`source_discovery_only` は throw せず PARTIAL_FAILURE を
  返すため、ループ内の status チェック＋RAISE でオブジェクト単位に例外送出、ADR-0004 の
  旧 dependency 保護もそのまま）。SQL のみ／エンジン不変。
- **残タスク（未実施）**：
  - **① フルのバッチ化（実施済み）**：STEP 3 の `FOR ... DO` ループを撤廃し、
    完全な集合ベースに置換。(1) メタデータ scoping を全obj 1 クエリ（`batch_object_metadata`）、
    (2) 本解析 UDF を解析可能 obj 全件で 1 ジョブ（`batch_udf_results`）、(3) dependency /
    diagnostic を集合で staging、(4) オブジェクトキーの temp（`batch_completed_objects` /
    `batch_udf_failed_objects` / `batch_preanalysis_failures`）を使い数本の集合 DML で公開。
    STEP 3 のジョブ数が ~15〜20N → 定数に。意味論は維持（COMPLETED=公開、非COMPLETED=旧
    dependency 温存＋UDF_RESULT_NOT_PUBLISHABLE、事前失敗=ANALYSIS_EXECUTION_FAILED 追記＋
    FAILED、ADR-0004 準拠）。
    **挙動変更**：公開はオブジェクト単位ではなく **バッチ原子的**。staging を全部先に計算し、
    破壊的 DML はバックアップ（`batch_previous_*`）を取ってから実行、失敗時は復元して RAISE。
    失敗runはリポジトリを変更しない（部分更新なし）。UDF は throw せず status を返すので
    解析失敗はデータとして隔離される。SQL のみ／エンジン不変。
    **未検証**：本環境から BigQuery 実行はしていない。本番前に dry-run パースと staging 実行、
    旧ループとの出力 diff（direct_dependency / lineage_diagnostic / definition_registry）で検証すること。
  - **③ ループ内 DML の集約**：①に包含済み（公開 DML は集合化された）。

## 4.6 消えたソースの not-found を FAILED 扱いしない（03 STEP 3）

- **症状**：DAG/生成テーブルが参照する temp/一時テーブルが今は存在せず、メタデータが
  無いため not-found。エンジンは「メタデータ皆無＝WARNING（PHYSICAL_METADATA_NOT_FOUND /
  SOURCE_METADATA_NOT_COLLECTED）」「列だけ無い＝ERROR（PHYSICAL_COLUMN_NOT_FOUND）」を
  区別するが、WARNING 1 つでも `analysis_status` が COMPLETED_WITH_WARNINGS になり、
  パイプラインは `COMPLETED` 以外を非公開＝FAILED＋UDF_RESULT_NOT_PUBLISHABLE＋
  is_changed=TRUE（毎回リトライ）にしていた。
- **対応**：STEP 3 で `INFORMATION_SCHEMA.TABLES`（`current_target_tables`）を使い原因を
  切り分け（`batch_object_source_flags`）。ソースが TABLES に**無い**＝本当に消えている
  （想定内）、TABLES に**在るが列未収集**＝本物のカバレッジ不足。判定 `is_publishable`＝
  「status が厳密 COMPLETED、または COMPLETED_WITH_WARNINGS かつ present-but-uncollected
  ソースが無い（＝WARNING は全て消えたソース起因）」。publishable は正常終了：解決できた
  依存を公開、消えたソースの WARNING は診断に**出さない**、registry=COMPLETED／
  is_changed=FALSE（リトライ停止）。ERROR あり・PARTIAL_FAILURE・present-uncollected あり
  は従来通り FAILED で表面化。※消えたソース WARNING と別の実 ERROR が混在する object は
  FAILED のまま全診断を保持（安全側）。SQL のみ／エンジン不変。**BigQuery 未検証**。

## 4.7 関数結果への後置フィールドアクセス（`fn(...).string_value`）の誤 not-found 修正

- **症状**：GA4 の `fn('key', event_params).string_value` のような「**関数呼び出し結果への
  ドットアクセス**」で、末尾 `.string_value` が裸の列 `string_value` として誤解決され
  `PHYSICAL_COLUMN_NOT_FOUND`（ERROR）→ COMPLETED_WITH_ERRORS → 非公開/FAILED。
- **原因**：パーサの後置処理（`#parsePostfixExpression`）が `OVER` と 添字 `[...]` のみ対応で、
  `)`/`]` の直後の `.field` を扱えず、select 項目が RAW_EXPRESSION に退避 → 中の識別子
  `string_value` を裸の列参照として収集していた。
- **修正**：後置 `base.field`（関数呼び出し/括弧式/添字の結果）をパース対応（`#parseFieldAccess`）。
  配列添字と同じ設計で、**末尾フィールドは lineage を持たない**（不透明な戻り STRUCT の
  フィールド選択）、**base（関数なら引数）の lineage のみ保持**。よって出力は `event_params`
  （その全 field_path に広く帰属）に依存し、`.string_value` は非計上。列への識別子チェーン
  `event_params.value.string_value` は後置段の前に消費されるため無影響。テスト
  `test_v1_5_0_049`。エンジン変更（要 GCS 再デプロイ）。

## 4.8 文字列リテラル `'ALL'`/`'DISTINCT'` を SELECT 修飾子と誤認する不具合

- **症状**：先頭 SELECT 項目が `'ALL' AS col1` のような**文字列リテラル**のとき
  "SelectParser: SELECT item 1 has no expression"（PARTIAL_FAILURE）。
- **原因**：`SelectParser#removeSelectModifiers` が `SELECT [ALL|DISTINCT]` 集合修飾子と
  `AS STRUCT|VALUE` を先頭から除去する際、`normalized_token` だけで判定していた。文字列
  `'ALL'`（token_type=STRING、normalized_token="ALL"）を修飾子と誤認し除去 → 式が消えた。
- **修正**：修飾子判定に **`token_type === "KEYWORD"` を追加**（ALL/DISTINCT/AS はキーワード、
  文字列は STRING）。本来の `SELECT ALL/DISTINCT` や `SELECT AS STRUCT|VALUE` は無影響。
  テスト `test_v1_5_0_050`。エンジン変更（要 GCS 再デプロイ）。

## 4.9 未クォートのダッシュ付きテーブルパス（`my-project.d.t`）の FROM 解析

- **症状**：FROM に未クォートのダッシュ付きテーブルパス（ダッシュ付きプロジェクトID
  `my-project.dataset.table` 等）があると "FromParser: JOIN was expected, but found -"
  （PARTIAL_FAILURE）。バッククォート版 `` `my-project.d.t` `` は従来通り可。
- **原因**：レキサが `my-project` を `my`/`-`/`project` に分割。`FromParser#parseTableSource`
  は `.` 区切りしか辿らず最初の `-` で停止。加えて数字終わりのID（`my-project-123.d`）は
  レキサが `123.` を区切りドットごと1数値トークンとして食う別問題もあった。
- **修正**：(1) `FromParser#parseTableSource` がハイフン連結（`my - project`→`MY-PROJECT`、
  数値セグメントも）を1パートに統合。(2) レキサは、数値直後の `.` が**英字識別子の前**なら
  数値に取り込まず区切りとして扱う（`123.dataset`→`123`/`.`/`dataset`）。小数
  `1.5`/`1.`/`1.5e3`/`3.14` は無影響。テスト `test_v1_5_0_051`。
- **既知の限界**：区切り無しで数字と英字が混在するセグメント（例 `my-2nd`）は依然
  誤トークン化 → その場合はバッククォート推奨。エンジン変更（要 GCS 再デプロイ）。

## 4.10 名前付きクエリパラメータ `@key` / `@@system_var` の対応

- **症状**：JOBS 収集 SQL に dbt 由来の `@key` 等の名前付きパラメータがあると、式パーサが
  `token "@" cannot start an expression`（式コンテキスト→PARTIAL_FAILURE）／SELECT 位置では
  RAW_EXPRESSION に退避して名前を裸の列として誤解決（PHYSICAL_COLUMN_NOT_FOUND）。
- **原因**：Lexer は `@` を単独 UNKNOWN トークンとして返すが、式パーサに `@` を始端とする
  一次式が無かった。
- **修正**：`@name` / `@@name` を **LITERAL_EXPRESSION（kind "PARAMETER"）** としてパース。
  パラメータは外部スカラー値でテーブル列ではないため **lineage を持たない**。`@` 直後の名前は
  予約語でも消費（`@end` / `@order` も有効なパラメータ名）。同一文の実列 lineage は保持。
  テスト `test_v1_5_0_052`。エンジン変更（要 GCS 再デプロイ）。

## 4.11 EXTRACT / WEEK(<WEEKDAY>) デートパートの解析

- **症状**：`EXTRACT(part FROM expr [AT TIME ZONE tz])` が特殊構文として未対応。SELECT 位置は
  RAW_EXPRESSION フォールバックで通っていたが、WHERE 等では `expected ")" but found "FROM"`
  （PARTIAL_FAILURE）。さらに `EXTRACT(WEEK(MONDAY) FROM dt)` の `MONDAY` や `AT TIME ZONE` の
  `AT` を列と誤認（PHYSICAL_COLUMN_NOT_FOUND）。`DATE_TRUNC(dt, WEEK(MONDAY))` の `MONDAY` も同様。
- **修正**：`EXTRACT` を特殊構文としてパース（`#consumeDatePart` で part を読み飛ばし、`FROM` の
  後の source 式と `AT TIME ZONE` の tz 式のみ lineage 保持）。`WEEK(<WEEKDAY>)` は
  デートパート（非スカラー関数）として no-lineage リテラル化。bare datepart 引数
  （`DATE_TRUNC(dt, WEEK)` / `DATE_DIFF(a,b,DAY)`）は無影響。テスト `test_v1_5_0_053`。
  エンジン変更（要 GCS 再デプロイ）。

## 4.12 definition_registry に labels 列を追加（エラー追跡用）

- **目的**：FAILED オブジェクトを DAG（dag_id / task_id 等）へ紐付けやすくする。labels は
  既に `lineage_job_registry` にあるが、解析/エラーの主テーブル `lineage_definition_registry`
  には無く join が必要だった。
- **実装（SQLのみ・エンジン不変）**：01 の definition_registry に
  `labels ARRAY<STRUCT<key STRING, value STRING>>` を追加。03 STEP 2 で
  `latest_generated_table_definitions` に labels を通し、生成テーブルの def_registry MERGE
  （MATCHED UPDATE / NOT MATCHED INSERT 両方）で `source.labels` を格納。View（STEP 1）は
  未指定＝NULL 既定。
- **移行注意**：01 は `CREATE OR REPLACE TABLE`（データ消去）。既存本番では 01 を再実行せず
  `ALTER TABLE <definition_registry> ADD COLUMN IF NOT EXISTS labels ARRAY<STRUCT<key STRING,
  value STRING>>;` を実行 → 次回日次で生成テーブル分が backfill される。

## 4.13 `JOIN ... USING(col)` 結合キーの AMBIGUOUS 誤検知を修正

- **症状**：全ソースが CTE、2 回 INNER JOIN、`USING` 結合、カラム修飾なしの SQL
  （`SELECT id FROM c1 INNER JOIN c2 USING(id) INNER JOIN c3 USING(id)`）で、`id` が
  「複数ソースに存在する曖昧な列」と判定され `PHYSICAL_COLUMN_AMBIGUOUS`（ERROR）。
- **原因**：パーサ（`from_parser.js`）は `JOIN ... USING(col)` の列を `join.using_columns`
  に記録していたが、リゾルバが未使用。`source_resolver.js #resolveQueryScope` は JOIN 登録時に
  USING 情報を scope に残さず、`column_resolver.js #resolveUnqualifiedReference` は候補ソースが
  2 件以上あれば無条件で `AMBIGUOUS` を返していた。`USING` は結合キーを 1 論理列へ統合する構文
  なので、この参照は本来曖昧でない。
- **修正（エンジン変更・要 GCS 再デプロイ）**：
  - `source_resolver.js` — scope に `join_using_columns: []` を追加し、JOIN ループで
    `join.using_columns` を正規化（大文字化）して記録。
  - `column_resolver.js` — 非修飾参照で候補が 2 件以上のとき、列名が `scope.join_using_columns`
    に含まれれば登録順で先頭（FROM/左側）の候補へ確定解決し、`#getColumnStatus` で状態を付与。
    含まれなければ従来どおり `AMBIGUOUS`。
- **リネージ属性**：結合キーは左ソース側に付く。両ソースへの完全なユニオン属性は
  lineage_resolver が単一 source_id で派生を辿る設計のため、より大きな変更になる（今回は誤 ERROR
  解消を優先）。
- **回帰**：`ON` 結合（USING でない）で両ソースに同名列があり修飾なし参照は、従来どおり
  `PHYSICAL_COLUMN_AMBIGUOUS` のまま。テスト `test_v1_5_0_056.js`。

## 4.14 USING 列が FROM/左側ソースに無いケースの解決（4.13 の追随）

- **症状**：`SELECT cola FROM tablea INNER JOIN aaa USING(id) INNER JOIN bbb USING(cola)` で、
  `cola` が CTE `aaa`/`bbb` にあり FROM の物理表 `tablea` には無い場合、4.13（v1.5.0-056）の
  「USING 列を先頭候補へ確定解決」が物理表 `tablea` を選び、`tablea` に `cola` が無く
  `PHYSICAL_COLUMN_NOT_FOUND`（ERROR）。
- **原因**：`#findUnqualifiedCandidates` は物理ソース（列不明＝`#getKnownOutputColumns`==null）を
  常に候補に含めるため、候補は `[tablea, aaa, bbb]`。056 は無条件に `candidateSources[0]`
  （=tablea）を選んでいた。USING 列は結合先のいずれかにあればよく、FROM 側が必ず持つとは限らない。
- **修正（エンジン変更・要 GCS 再デプロイ）**：`column_resolver.js #resolveUnqualifiedReference` の
  USING 分岐で、候補のうち列を公開すると分かっているもの（`#getColumnStatus`==`"RESOLVED"`＝
  CTE/派生で出力列に含む）を `find` で優先。見つからない（全て物理でスキーマ未連携）場合のみ
  `candidateSources[0]` へフォールバック。結合キーはその公開ソースへ属性（例では `cola` →
  CTE → 物理 `p.d.src.cola`）。
- **回帰**：FROM の物理表側に USING キーがある通常ケースも従来どおり解決。テスト `test_v1_5_0_057.js`。

## 4.15 `UNNEST(array) WITH OFFSET AS offset` の別名が予約語 `offset` のケース

- **症状**：`SELECT id, offset FROM t, UNNEST(arr) AS e WITH OFFSET AS offset` で、SELECT の
  `offset` の出力列名が解決できず `OUTPUT_COLUMN_NAME_UNRESOLVED`（WARNING、
  `COMPLETED_WITH_WARNINGS`）。別名が `pos` 等の通常識別子ならクリーンだった。offset 値自体の
  解決（リネージ無し）は問題なく、出力名の導出だけが失敗していた。
- **原因**：`offset` は Lexer が `OFFSET` キーワードとして字句化する。SelectParser の暗黙出力名
  導出 `#deriveColumnAlias` が `#isIdentifierToken`（IDENTIFIER/BACKTICK のみ）で判定していたため
  KEYWORD の列名を導出できなかった。一方 ExpressionParser の `#isIdentifierToken` は非予約 KEYWORD
  を識別子（列参照）として解決するため、式ASTは `offset` を列として扱えていた（不整合）。
- **修正（エンジン変更・要 GCS 再デプロイ）**：SelectParser に `#isColumnNameToken` を追加し、
  ExpressionParser と同じ予約語集合（`NULL`/`TRUE`/`FALSE`・論理/句キーワード等）を除いた KEYWORD を
  列名として受理。`#deriveColumnAlias` の単一トークン列・ドット修飾列の両方でこれを使う。`OFFSET`
  等の非予約語は列名になり、真の予約語リテラル（`NULL` 等）は従来どおり無名のまま。
- **回帰**：識別子別名 `pos`、`SELECT NULL`（無名維持）を併せて確認。テスト `test_v1_5_0_058.js`。

## 4.16 `INTERVAL <expr> <part>` の値が算術式のケース

- **症状**：`DATE_ADD(d, INTERVAL n * 2 DAY)` や `INTERVAL n + 1 DAY` のように INTERVAL の値部が
  算術式だと、関数引数内で `ExpressionParser: expected ")", but found "day"`、素の SELECT 項目では
  `INTERVAL` が列参照へ誤解決し `PHYSICAL_COLUMN_NOT_FOUND`。リテラル値 `INTERVAL 2 DAY` や
  単独列 `INTERVAL n DAY` は問題なかった（値の後ろに演算子が無いため）。
- **原因**：`#parseIntervalExpression` が値部を `#parseUnaryExpression`（単項精度）で解析していた。
  単項は `*`/`/`/`+`/`-` の手前で止まるため、`n * 2` の場合 `n` だけを値として返し、続く `* 2 DAY` が
  取り残される。関数引数では末尾の日付単位が閉じ `)` 検査に衝突し、素の式では式解析失敗の
  フォールバックで先頭語が列扱いになっていた。
- **修正（エンジン変更・要 GCS 再デプロイ）**：値部を `#parseAdditiveExpression`（加減算精度、
  乗除算も含む）で解析。日付単位（DAY 等）は裸のキーワードで演算子ではないため、加減算解析は必ず
  単位の手前で停止し過剰消費しない。値部に含まれる列（例: n）の依存も lineage に保持される。
- **回帰**：リテラル値・単独列・負値・`DAY TO SECOND` 句を併せて確認。テスト `test_v1_5_0_059.js`。

## 4.17 `CREATE ... AS (SELECT ...)` の括弧付き本体

- **症状**：`CREATE OR REPLACE TEMP TABLE t AS (SELECT ...)` で QueryParser が
  「トップレベルの SELECT Clause が見つかりません」。括弧なし `CREATE ... AS SELECT ...` は
  通っていた。
- **原因**：ClauseParser は深さ0の SELECT を探すが、`AS (SELECT ...)` では SELECT が括弧内（深さ1）
  に入る。既存の `#stripWrappingParentheses` は「先頭の非コメント Token が '('」の全体括弧しか
  剥がさないため、`CREATE ... AS` の前置きの後ろに来る括弧付きクエリには対応していなかった。
- **修正（エンジン変更・要 GCS 再デプロイ）**：QueryParser に `#stripStatementBodyParentheses` を追加。
  深さ0の `AS` の直後（コメント除く）が深さ0の `(` で、その対応する `)` が末尾（末尾 ';' 無視）に
  一致し、内側が SELECT/WITH で始まる場合に、括弧内のクエリだけを取り出して `#normalizeTokenDepth`
  後に再解析する。対象テーブル名は解析メタデータ（view_project/dataset/name）で与えるため、
  `CREATE ... AS` の前置きは lineage に寄与しない。
- **非対象（回帰確認済み）**：`WITH t AS (...) SELECT ...`（括弧の後ろに続きがある）、列別名 `x AS y`、
  スカラーサブクエリ `(SELECT ...) AS y`、括弧なし CTAS、全体括弧 `(SELECT ...)`。テスト `test_v1_5_0_060.js`。

## 4.18 UDF out of memory 対策：物理列メタデータの縮小（SQLのみ）

- **症状**：解析対象を増やしたところ、03 STEP 3 の JS UDF で "Resource exceeded during query
  execution / UDF out of memory"。
- **切り分け**：エンジンにモジュールレベルの蓄積状態（行をまたぐキャッシュ）は無く、各 UDF 呼び出しは
  独立（呼び出しごとに `new LineageEngine` → 文字列を返すのみ）。よって BigQuery の JS UDF メモリ上限に
  対し、単一の巨大オブジェクト（大きな SQL＋大きなメタデータ）または多数行処理でのヒープ蓄積が原因。
- **対処（今回・SQLのみ）**：UDF へ渡す per-object の `physical_columns_json` から `data_type` /
  `is_nullable` を除去。エンジンはこれらを内部で伝播するだけで、エクスポート出力（lineage_paths /
  physical_column_references 等）には一切含めないため、解析結果は不変（`test_v1_5_0_061.js` で
  「出力が data_type/is_nullable の有無に依存しない」ことを固定）。ネスト/複合型の `data_type`
  （`ARRAY<STRUCT<...>>` 等、GA 系イベントテーブル）は1列のバイト数を支配し得るため、広い/深い
  テーブルを参照するオブジェクトのペイロードが大きく縮む。`03_...sql` の agg で ARRAY_AGG の STRUCT と
  METADATA_TOO_LARGE 用の BYTE_LENGTH の両方から2フィールドを削除。エンジンバンドルは不変。
- **未実施の追加レバー（必要なら）**：SQL本文サイズのガード追加、METADATA_TOO_LARGE 閾値の引き下げ、
  UDF バッチのチャンク分割（固定件数ループ）。ユーザー選択は「メタデータ縮小」のみ。

## 4.19 UDF out of memory 対策：STEP 3 UDF のチャンク分割（4.18 の続き・SQLのみ）

> **⚠ 撤回済み（現行ソースには存在しない）**：このチャンク分割は後続作業で
> **完全に撤去**され、**データセット単位のループ**へ置き換えられた。`analysis_udf_chunk_size`
> などの DECLARE も `udf_chunk` 列も現在の `03_...sql` には無い。詳細は §4.21。

- **4.18 では解消せず**（メタデータ縮小では効かなかった）。実データ診断で原因を確定：
  対象 **2667 件**、最大 SQL **64KB**、中央値 192B、p95 9KB。**単一の巨大 SQL は無く**、
  全件を 1 クエリで UDF 実行する際の**スロット上の V8 ヒープ蓄積（集約ピーク）**が原因。
- **対処（今回・SQLのみ）**：STEP 3 の UDF 実行を全件1クエリ→**固定件数チャンクのループ**へ変更。
  - `analysis_udf_chunk_size`（新 DECLARE・既定 200）を追加。
  - `batch_analysis_input` に `udf_chunk` 列（analyzable 行を analyzability で PARTITION した
    ROW_NUMBER を chunk_size で DIV）を追加。
  - `batch_udf_results` は UDF SELECT の `WHERE FALSE` で**空テーブルとして先に作成**（UDF 未評価で
    スキーマ確定）。以後 `INSERT ... WHERE udf_chunk = @chunk_index` を chunk_count 回ループ。
  - `analysis_udf_chunk_count = DIV(COUNT(*) + size - 1, size)`（0 件なら 0 → ループ無し）。
  - INSERT テンプレートはループ外で1回 render、`@chunk_index` のみ差し替え。
  - 効果不足なら chunk_size を下げる／過剰なジョブ数なら上げる。トレードオフ：単一クエリより
    逐次ジョブ数が増える。エンジンバンドルは不変・**BigQuery 未検証**。
- **※4.19 だけでは解消せず**：03 には UDF 全件パスが2つあり、探索パス（下記 4.20）が未分割で残っていた。

## 4.20 UDF out of memory 対策：ソース探索パスのチャンク分割（4.19 の続き・SQLのみ）

> **⚠ 撤回済み（現行ソースには存在しない）**：`discovery_udf_chunk_size` を含め撤去され、
> ソース探索も**データセット単位のループ**（探索プリパス）になっている。詳細は §4.21。

- **症状の継続**：4.19（STEP 3 チャンク分割）を入れても、対象増加時にまだ "UDF out of memory"。
  `analysis_udf_chunk_size` を下げても効かない。
- **原因**：03 には JS UDF を changed 全件に回すパスが**2つ**ある。
  ① **ソース探索**（1652 付近）：`source_discovery_only` モードで UDF を全 changed 定義に回し
     `changed_definitions_with_discovery`（`source_discovery_json`）を作る単一クエリ。**未分割だった**。
  ② **STEP 3 解析**（2090 付近）：4.19 で分割済み。
  ①も同じ集約ピークで OOM するため、②だけ分割しても解消しない（②の chunk_size は①に無関係）。
- **対処（今回・SQLのみ）**：①も固定件数チャンクのループへ。
  - 新 DECLARE `discovery_udf_chunk_size`（既定 200、ブロック 1430 の変数群に追加）。
  - `changed_definitions_with_discovery` を UDF SELECT の `WHERE FALSE` で空作成（スキーマ確定）。
  - `discovery_udf_chunk_count = DIV(COUNT(*) + size - 1, size)`（changed_definitions_to_analyze 基準）。
  - `INSERT ... FROM (SELECT c.*, DIV(ROW_NUMBER() OVER(ORDER BY オブジェクトキー) - 1, @chunk_size) AS discovery_chunk
    FROM changed_definitions_to_analyze c) WHERE discovery_chunk=@chunk_index` を chunk_count 回ループ。
    UDF は選択チャンクの行だけに評価される。
  - `changed_definitions_to_analyze` 自体は不変（chunk は探索ステップ内で ROW_NUMBER 再計算）。
- **切り分けのヒント**：どちらのパスで落ちたかは失敗ジョブの SQL で分かる。
  `... changed_definitions_with_discovery ... source_discovery_json` なら①、
  `INSERT INTO batch_udf_results` なら②。エンジン不変・**BigQuery 未検証**。

## 4.21 UDF out of memory 対策の最終形：データセット単位ループ（4.18〜4.20 を置換）

- **結論**：固定件数チャンク（§4.19 / §4.20）は**撤回**。現行 03 は STEP 3 全体を
  **`FOR ds_row IN (SELECT ds FROM UNNEST(changed_datasets) ...) DO ... END FOR`**
  というデータセット単位のループで回す。`grep -i chunk sql/pipeline/03_...sql` は**0 件**。
- **撤回理由**：行数チャンクは 1 ジョブあたりの UDF 呼び出し回数は抑えるが、
  大きいオブジェクトが同じチャンクに固まると**合計メモリは抑えられず** OOM が再発した。
  実機で「1 データセットずつなら通る」ことが確認できたため、分割軸を行数から
  **データセット**へ変更した。
- **現行の構造（`03_run_daily_lineage_pipeline.sql`）**：
  1. `changed_datasets`（解析対象の変更オブジェクトを持つ dataset）を軽量プローブで取得。
     空なら STEP 3 の高コスト処理を丸ごとスキップ（`has_analysis_work`）。
  2. **探索プリパス**（1698〜1792 付近）：`changed_datasets` を 1 つずつ回し、
     `source_discovery_only` の UDF を単一クエリで実行 → `all_changed_with_discovery` に
     蓄積しつつ、参照されたソース dataset 名を `referenced_source_datasets` に集める。
  3. **メタデータ走査の絞り込み**（1823〜1901 付近）：`current_target_columns` /
     `current_target_column_field_paths` /（TABLES 実在集合）を、**参照された dataset だけ**に
     絞って STEP 3 内でロードする（従来はリージョン全 dataset を無条件ロード）。
  4. **解析ループ**（1934〜3541 付近）：再び dataset 単位で回し、各周回は
     `all_changed_with_discovery` から自 dataset 行を読み直すだけ（**探索 UDF の 2 回目実行は無い**）。
     周回内部は §4.5 の**フルバッチ（集合ベース）**のまま。
  5. STEP 4（impact 再構築）は dataset 横断のためループ**外**で 1 回だけ実行。
- **効果の要点**：dataset 単位に絞ることで UDF の行バッチだけでなく
  `changed_definitions_with_discovery` / `batch_object_metadata` / `batch_analysis_input` /
  `batch_udf_results` といった中間テーブルもすべて小さくなる。
- **§4.18 は現行でも有効**：UDF へ渡す `physical_columns_json` から `data_type` /
  `is_nullable` を落とす縮小は**残っている**（03 の agg、2263〜2287 付近）。
  固定テストは `test_v1_5_0_061.js`。
- **未検証**：この一連の変更も **BigQuery 実機での検証は完了していない**（CHANGELOG の
  各エントリ末尾に "Not yet validated against BigQuery"）。

## 4.23 定義ソース種別フィルタ `analysis_include_generation_types`（SQLのみ）

- **背景**：解析スコープの軸は §0.5 の 2 系統（dataset / object 名）＋
  `process_generated_tables`（生成テーブルを解析するかの ON/OFF）だけで、
  **「DAG のジョブ SQL だけを解析する」指定ができなかった**。レジストリには
  `generation_type`（`VIEW_DEFINITION` / `SCHEDULED_QUERY` / `DAG`。STEP 2 の
  `execution_source` 由来）が入っているのに、それで絞る手段が無かった。
- **追加**：`analysis_include_generation_types ARRAY<STRING> DEFAULT []`（[A]）。
  空＝全種別（従来と完全に同じ挙動）。`['DAG']` で DAG のみ、
  `['DAG','SCHEDULED_QUERY']` で View を外す。
- **検証**：[C] で trim/大文字化して `analysis_generation_types` に正規化し、
  既知の 3 値以外は ASSERT で即失敗させる（タイプミスで解析対象が黙って 0 件になるのを防ぐ）。
- **適用位置は収集段**（他の 2 軸と同じ＝レジストリ＝解析対象を維持）：
  - STEP 1：`VIEW_DEFINITION` が未選択なら `current_view_definitions` を全削除。
    「全 View を名前で除外した」のと同じ経路になり、既存行は "not found" ルールで
    deactivate される（active のまま取り残さない）。
  - STEP 2：`classified_jobs` の WHERE に、`generation_type` になるのと同じ CASE で
    ゲートを追加（`execution_source` は同一 SELECT の別名なので WHERE からは参照できず、
    CASE を書き下している）。
- **注意（コスト削減ではない）**：STEP 1 は VIEWS を、STEP 2 は JOBS を従来どおり走査する。
  JOBS 走査自体を止めるのは `process_generated_tables`。
- SQL のみ／エンジン不変。**BigQuery 未検証**。

## 4.24 アクセスできないソースデータセットで落ちる問題（SQLのみ）

- **症状**：03 実行時、`INFORMATION_SCHEMA.TABLES` を UNION する箇所で特定データセットに
  対し **Access Denied**。UNION ALL 一発なので、1 つ読めないだけで文全体が落ちる。
- **原因**：`source_project_filters` は SCHEMATA からソースデータセットを解決するが、
  **SCHEMATA に見えることと、そのデータセットの INFORMATION_SCHEMA が読めることは別**。
  従来の回避策は `source_project_filters[].dataset_exclude_patterns` に手で列挙するのみ。
- **対応**：STEP 1 の `source_datasets` 解決直後に**アクセス事前チェック**を追加。
  新 DECLARE `skip_inaccessible_source_datasets BOOL DEFAULT TRUE`（[B]）。
  - 各データセットを 1 回プローブし、失敗したものを `source_datasets` から DELETE。
  - 除外分は `inaccessible_source_datasets` に理由付きで残し、
    `SKIPPED_INACCESSIBLE_SOURCE_DATASETS` として結果に出す（黙って縮まないように）。
  - **全 UNION が `source_datasets` 由来**なので、ここで 1 回削るだけで
    STEP 1 の TABLES/TABLE_OPTIONS も STEP 3 の COLUMNS/COLUMN_FIELD_PATHS/TABLES も守れる。
  - プローブは 4 ビューを 1 ジョブで確認（`(SELECT 1 FROM ... LIMIT 1) UNION ALL ...`）。
    部分的にしか権限が無いデータセットが STEP 1 を通過して STEP 3 で落ちるのを防ぐため。
  - コストはソースデータセット数 × 1 ジョブ／run（バイト課金なし）。FALSE で従来動作。
  - 全滅した場合は ASSERT で失敗させる。
- **project 単位の穴も塞いだ**：`source_datasets` を解決する SCHEMATA ループ自体が
  project 全体の Access Denied で落ちうる（データセット単位のプローブに到達する前）。
  この `EXECUTE IMMEDIATE` も `BEGIN ... EXCEPTION WHEN ERROR THEN ... END` で包み、
  到達不能な project は `inaccessible_source_datasets`（dataset_id = NULL）に記録して継続。
  `skip_inaccessible_source_datasets = FALSE` のときは素の `RAISE` で元のエラーを再送出する。
- **なぜ捕捉できるか**：ソース参照はすべて動的（`EXECUTE IMMEDIATE`）なので、権限エラーは
  その文の**実行時エラー**として BEGIN ブロック内で発生する＝例外ハンドラで捕まる。
  静的にテーブル名を書いていると文の検証段階で落ちて捕捉できないため、この形が前提。
- **解析への影響**：外したデータセットのテーブルはメタデータに存在しなくなるため、
  §4.6 の分類では「消えたソース」扱い＝WARNING（公開可）であり FAILED にはならない。
- SQL のみ／エンジン不変。**BigQuery 未検証**。

## 4.25 03 実行前の対象確認 `preview_only`（SQLのみ）

- **要望**：「[A] の条件で狙った対象が選ばれているか」を 03 実行前に確認したい。
  当初は確認用の別スクリプト（02）案だったが、次の 2 点から **03 内のドライラン**にした。
  1. **02 は空き番号ではない**（`sql/sample/02_setup_sample_environment.sql` と `02a` が既存。
     README・INTEGRATION_TEST_PLAN からも参照されている）。
  2. **BigQuery に include 機構が無い**ため、別ファイルにすると `[A]` が 2 箇所になり必ずズレる。
     さらにフィルタ解決ロジックを再実装することになり、「確認した対象」と「本実行の対象」が
     食い違いうる。03 内なら **[A] は 1 つ、表示されるのは 03 自身が解決した値**。
- **追加**：`preview_only BOOL DEFAULT FALSE`（[B]）。TRUE で以下を出力して停止する。
  - `PREVIEW_SETTINGS` … 実際に効いている [A] の値
  - `PREVIEW_ANALYSIS_DATASETS` … 解析対象データセット＋View 件数（0 件も残す）
  - `PREVIEW_SOURCE_DATASETS` … ソースデータセット＋`ACCESSIBLE`/`SKIPPED_NO_ACCESS`（理由付き）
  - `PREVIEW_TARGET_VIEWS` … 全フィルタ通過後の View 一覧
- **書き込みゼロ**：レジストリの MERGE/UPDATE はもちろん、column usage テーブルの
  自己修復 `CREATE TABLE IF NOT EXISTS` も preview では実行しない。
- **停止のさせ方**（BigQuery に RETURN が無いための構造）：
  - 出力は STEP 1 の「target_datasets・source_datasets・フィルタ済み View が出揃い、
    まだ何も書いていない」地点に置く。
  - STEP 1 の残り、STEP 2（既存 IF に `AND NOT preview_only`）、STEP 3〜PIPELINE SUMMARY を
    `IF NOT preview_only THEN ... END IF;` でゲート。既存行は再インデントせず挿入のみ（差分最小）。
  - `CREATE TEMP TABLE non_completed_udf_results` は**ゲートの外**に残す。最終の
    FINAL OPERATIONAL RESULT の SELECT が最外ブロックの外にあり、テーブルが無いと落ちるため
    （preview では 0 件が返る）。
- **対象外**：生成テーブル（Scheduled Query / DAG）は一覧に出ない。列挙には STEP 2 の
  JOBS 走査が必要で、preview でそのコストを払わないため。通知メッセージにも明記。
- ドキュメントは `docs/OPERATION_GUIDE.md` §7。SQL のみ／エンジン不変。**BigQuery 未検証**。

## 4.26 `{project_token}` が `source_project_filters` に効かない（SQLのみ）

- **症状**：`source_project_filters` の `project_id` に `{project_token}` を書くと
  `Invalid source project_id in source_project_filters`。
- **原因**：置換ブロック（03 の 389-396 付近）が `repository_dataset` / `udf_dataset` /
  table・UDF の prefix/suffix しか対象にしておらず、`source_project_filters` は**未対応**。
  リテラルのまま STEP 1 の project_id 検証 ASSERT に到達し、`{` `}` が不正文字として弾かれる。
  対象外だったのは `source_project_filters` が **STRUCT 配列**で、単純な `REPLACE` ではなく
  配列の作り直しが必要だったため。
- **対応**：`SET source_project_filters = ARRAY(SELECT AS STRUCT ... FROM UNNEST(...))` で
  `project_id` と `dataset_include/exclude_patterns` を置換して再構築。併せて
  `scheduled_query_service_accounts` / `dag_service_accounts` も置換対象に追加
  （SA メールはプロジェクト ID を含むのが普通で、「一部の [A] だけ効く」状態は事故のもと）。
- **併せて**：project_id の ASSERT メッセージに「未置換の `{project_token}` を疑え／
  `project_token_pattern` が不一致だとトークンは空文字になる」旨を追記。
  `preview_only` の `PREVIEW_SETTINGS` に `detected_project_id` と `project_token` を追加し、
  実行前にトークン抽出の成否が見えるようにした。
- SQL のみ／エンジン不変。**BigQuery 未検証**。

## 4.27 column usage impact ビューの `line_text` から行頭インデントを除去（SQLのみ）

- **要望**：`lnge_vw_t_column_usage_impact` の `line_text` の行頭インデントが邪魔。
- **対応（ビュー側）**：両ブランチ（depth=1 / depth=impact_rank+1）で
  `LTRIM(u.line_text) AS line_text` に変更し、`line_indent_width`
  （`LENGTH(line_text) - LENGTH(LTRIM(line_text))`）を追加。
  - **エンジン側ではなくビュー側**にしたのは、収集済みの行にも即座に効き、バンドル再デプロイも
    03 の再解析も不要なため。
  - `column_number` は**元の行における位置**のまま据え置き（definition_registry の
    定義本文と突き合わせたときに整合する）。トリム後テキスト内の位置は
    `column_number - line_indent_width`。
- **併せて 01 に `recreate_views_only BOOL DEFAULT FALSE` を追加**：
  01 のセクション 4 は `CREATE OR REPLACE TABLE` でテーブルを作り直す（＝データ消去）ため、
  稼働中の環境ではビュー変更を取り込むために 01 を再実行できなかった＝**ビューを貼り直す
  安全な手段が存在しなかった**。TRUE でセクション 4（テーブル DDL）・4b/5（renderer・UDF）・
  6（スモークテスト）をスキップし、**新設のセクション 4a（ビュー）だけ**を再作成する。
  ビュー DDL を別スクリプトに複製せずに済むのが要点。
  setup summary は `views_only_run` を出力し、`smoke_test_status` は NULL になる。
- **usage の SQL 本文も同ビューに追加**（`usage_definition_text` / `usage_definition_is_current`）。
  両ブランチで definition_registry を **object キー（project/dataset/name/type）** で LEFT JOIN。
  このキーは registry の MERGE キーそのもので **1 オブジェクト＝1 行**なので行の増殖が起きない
  （`definition_hash` だけで結合すると、同一 SQL の別オブジェクトと多重マッチしうる）。
  本文を返すのは `d.definition_hash = u.definition_hash` のときだけ：オブジェクトが再定義されると
  registry の現在のテキストは**別の SQL** で `line_number` が合わなくなるため、
  それらしい誤情報を返さず NULL にする。`usage_definition_is_current` が
  TRUE=一致 / FALSE=再定義済み / NULL=registry 行なし を区別する。
  ビューなので、選択しないクエリでは BigQuery が列を刈り取りコストはかからない。
- **`column_number` の意味と `word_number` の追加**：`column_number` は Lexer の
  `column_no`（`advanceCharacter` で 1 文字ごとに +1、改行で 1 にリセット）由来で、
  **行頭インデントを含む文字位置**・**タブは 1 カラム**（タブストップ換算ではない）。
  正確だが目視で数えるには不向きなため、`word_number`（参照が入っている空白区切り
  ワードの 1 始まり番号。インデントの影響を受けない）と `word_text`（そのワード自体）
  を追加。`a.col` の `col` や `f(col)` の `col` のように単語の途中から始まる参照は、
  それを含むワード（`a.col` / `f(col)`）を返す＝人が行を見て探す単位に合わせている。
  **ビュー内で `line_text` と `column_number` から計算**しているので既存行にも効く
  （エンジンで語彙トークン番号を持たせる案は、再デプロイ＋再解析が必要で既存行に効かない）。
  併せてビュー本体を CTE（`usage_words` → `usage_located`）に整理し、位置計算と registry
  参照を 2 ブランチで共有（FORMAT プレースホルダも 12→8 に減）。
- SQL のみ／エンジン不変。**BigQuery 未検証**。

## 4.28 使用箇所つき SQL の HTML 描画（Looker Studio 用・SQLとツールのみ）

- **要件**：column usage impact ビューの SQL を Looker Studio で「行番号つき・該当行
  ハイライト・該当箇所ハイライト」で表示したい。
- **前提調査**：別ブランチ `claude/looker-studio-ddl-diff-ddqsyd` の `looker_studio/` に
  確立された方式がある。**自作 community visualization は公開 GCS バケットが必須**で
  （Looker Studio がサーバー側で JS を取得するため、ドメイン限定 IAM だと 403）、
  禁止環境では使えない。ギャラリー掲載の **Templated Record**（HTML カラムを描画する
  汎用チャート）＋ **BigQuery の JS UDF で HTML を生成**、が推奨構成。
- **実装**：
  - レンダラ本体 `javascript/src/html/usage_sql_html.js`（純関数・テスト可能）
  - `javascript/scripts/build_usage_html_udf.js` が 01 の**番兵ブロック**へ差し込み、
    自己完結の UDF `lnge_fn_usage_sql_html` / `lnge_fn_usage_sql_css` を作る。
    **エンジン バンドルとは無関係**（GCS 再デプロイ不要・sha256 不変）。
  - `npm test` に `verify:usage-html-udf` を組み込み、01 のブロックが src と
    ズレていたらビルドを失敗させる。BigQuery のインライン コード ブロブ上限 32KB も
    ここで検査（現状 15KB）。
  - ビューは末尾に `impact_rows` CTE を足し、最終 SELECT で
    **分析関数 ARRAY_AGG（起点カラム × オブジェクト × 定義 で PARTITION）**により
    関連箇所を全部集めて UDF に渡す。分析関数は WHERE の後に評価されるので、
    レポートが起点で絞れば対象も絞られる。
- **設計上の判断**：
  - ハイライトは 1 箇所ではなく**関連する全箇所**（1 レコード表示の Templated Record 向け）
  - 位置は `line:column:length` 文字列。`column_number` はインデントを含む文字位置なので
    **タブを空白に展開してはならない**（位置がずれる）
  - 経路違いの重複と範囲の重なりは **UDF 側で畳む**（分析関数では
    `ARRAY_AGG(DISTINCT)` が使えないため）
  - モードは `embed`（既定・自己完結）/ `class`（最小）/ `inline`
  - 既定は**全文**。`contextLines` で窓にできる
- テスト `test_v1_5_0_075`（class の markup が使う class が CSS に全部あることも固定）。
  レポート作成者向けの説明は `docs/VIEW_COLUMN_USAGE_IMPACT.md` §6。
- **命名は他の UDF と同一扱い**（初版はテーブル用 prefix/suffix ＋ リポジトリ
  データセットに作っていたので修正）：
  `bootstrap_udf_name_prefix || 'lnge_' || base || bootstrap_udf_name_suffix`
  （marker 無し。`analyze_json` / `fingerprint_sql` / `render_dynamic_sql` と同じ）。
  作成先も `bootstrap_udf_project_id` / `bootstrap_udf_dataset`。
  よってビューからの呼び出しは 3 部構成（`project.udf_dataset.function`）。
  関数名は `lnge_usage_sql_html` / `lnge_usage_sql_css`。
- SQL とツールのみ／エンジン不変。**BigQuery 未検証**。

## 4.29 `CREATE ... AS` 前置きの解析と、03 のストリップを消してはいけない理由

- **見つかった不具合**：`CREATE ... AS WITH c AS (...) SELECT ...` で**系統が静かに消える**。
  `#parseCommonTableExpressions` は先頭 Token が `WITH` のときしか CTE を解析しないため、
  `CREATE` で始まると CTE が読まれず、ClauseParser が拾う深さ0の SELECT だけが残って
  CTE 名が未知ソース化 → `COMPLETED_WITH_WARNINGS`（エラーにならない）。
  CTE の無い `CREATE ... AS SELECT` は通っていたので気づかれていなかった。
- **エンジン修正**：`#stripStatementPrefix` を追加。先頭が `CREATE` / `EXPORT` のとき、
  **深さ0の最初の `AS`** の直後（SELECT / WITH / `(` で始まること）から本体として再解析。
  深さ0の AS を境界にするので、列スキーマ・`PARTITION BY`・`CLUSTER BY`・`OPTIONS(...)`
  がどう並んでも影響を受けない（いずれも括弧内か AS より前）。
  **CREATE / EXPORT 限定なのが肝**で、これが無いと `WITH t AS (...)` の AS を境界と
  誤認して CTE ごと捨てる。テスト `test_v1_5_0_076`。
- **⚠ 03 の CTAS ストリップは削除できない**：`definition_text` は `sql_fingerprint` の
  入力で、フィンガープリントはリテラルを `?` にする一方**テーブル識別子は残す**。
  前置きを残すと宛先名が毎回変わる一時テーブルが別指紋になり、**ephemeral の集約
  （§2）が壊れてレジストリが膨張する**。エンジンが前置きを解析できるようになっても、
  ストリップの役目は解析ではなく指紋の安定化なので残す。03 の該当箇所にコメント済み。
- **併せて 03 の正規表現を汎用化**：旧版は前置きの形を列挙しており
  `PARTITION BY` / `CLUSTER BY`・列スキーマ・`CREATE TEMP TABLE` を取りこぼしていた
  （＝それらは宛先名込みで指紋化され、集約が効いていなかった）。RE2 に先読みが無いため、
  「最初の ` AS ` で直後が SELECT / WITH / `(` のもの」を境界にし本体をキャプチャして
  書き戻す形にした。**該当オブジェクトは definition_hash が変わるので一度だけ再解析される。**
- **未対応のまま**：`MERGE` / `UPDATE` / `DELETE` / `INSERT ... VALUES`。これらは
  書き込み先との列対列マッピングという別概念が要るうえ、03 の収集条件
  （`collected_statement_types`）にも入っていない。

## 4.30 別名なし UNNEST の要素フィールドをドット付きで参照した形（GA4）

- **症状**：DAG SQL の
  `COALESCE((SELECT value.string_value FROM UNNEST(event_params) WHERE key='utm_campaign'), ...)`
  で `LINEAGE_PARTIALLY_RESOLVED ... @scope N (EXPRESSION_SUBQUERY) [UNRESOLVED_SOURCE]`。
- **切り分け**：**式サブクエリは無関係**。FROM 句に UNNEST を書いた同じ形でも再現する。
  真の条件は「**別名なし UNNEST × ドット付き参照**」。
- **原因**：ColumnResolver は 2 部構成の識別子を「修飾子.列名」と読むため、
  `value.string_value` の `value` をソース別名とみなす。別名なし UNNEST は別名を持たないので
  UNRESOLVED_SOURCE。単一部の `key` は**修飾なし**参照として既存の単一 UNNEST フォールバックが
  拾い、別名付き `ep.value.string_value` は別名が解決するため、この形だけが取り残されていた。
- **修正**：`physical_column_resolver.js` で、**修飾ありかつ UNRESOLVED_SOURCE** の参照を、
  スコープ内の UNNEST が 1 つだけのとき UNNEST 解決へ委譲する（修飾子ごと要素内フィールド
  パス扱い。`#resolveCorrelatedUnnestReference` は `reference_name` 全体をフィールドパスとして
  扱うので追加の細工は不要）。`#resolveStructFieldPathReference` の**後**に置いているので、
  物理のネスト STRUCT（`geo.region`）の優先順位は不変。UNNEST が複数あるスコープでは
  決められないため従来どおり未解決のままにする（誤帰属を作らない）。
- テスト `test_v1_5_0_077`。エンジン変更（要 GCS 再デプロイ）。

## 4.31 テーブル別名を行値として使う形と、非予約 Keyword の明示 alias

- **症状**：CTE 側の
  `SELECT ARRAY_AGG(t ORDER BY aaa LIMIT 1)[OFFSET(0)].session_id FROM cte t`
  が原因で、外側に `DERIVED_OUTPUT_COLUMN_NOT_FOUND` の警告が波及していた。
- **本質は警告ではなく偽陰性**：`t` を列として解決しようとして失敗し、
  **本来の依存（その行の列）が系統から丸ごと落ちていた**。`session_id` は ORDER BY キーの
  `aaa` にしか依存せず、`session_id` を変更してもこのオブジェクトが影響先に出てこない。
  物理表を直接参照する形では `PHYSICAL_COLUMN_NOT_FOUND`（ERROR）になっていた。
- **修正**：ExpressionParser が後置フィールド名を Node に残し（`field_access_name`）、
  ColumnResolver がそれを使って「スコープ内の表ソース別名に一致し、列として解決できない
  識別子」を `別名.フィールド` の修飾あり参照へ落とす。結果、系統はその 1 列に正確に付く。
  - **対象は PHYSICAL_TABLE / CTE / SUBQUERY のみ**。UNNEST の別名は行ではなく要素の値なので
    除外する（外さないと `FROM d.t AS t, UNNEST(Col) AS Col` を誤認する。開発中に
    `test_v1_5_0_065` が検出した）。
  - **後置フィールドが無い行値（`ARRAY_AGG(t) AS xs`）は対象外のまま**。「行の全列」に
    相当する参照を式の途中に差し込むと、SELECT 項目のワイルドカードを前提にした下流が
    クラッシュした。`test_v1_5_0_078` で「少なくとも落ちない」ことだけ固定してある。
- **併せて**：`SELECT x AS offset` が `SelectParser: invalid explicit alias` で解析失敗して
  いた問題を修正。`offset` / `value` / `key` は BigQuery の予約語ではない。暗黙 alias は
  §4.15（v1.5.0-058）で対応済みだったが、**明示 alias が IDENTIFIER 限定のまま**だった。
  `#isAliasToken` を `#isColumnNameToken` に揃えた（明示 `AS` がある分、暗黙側より安全）。
  真の予約語（`AS NULL` / `AS ROWS`）は従来どおり拒否、`CAST(x AS STRING)` は深さで区別。
- テスト `test_v1_5_0_078`。エンジン変更（要 GCS 再デプロイ）。

## 4.32 オブジェクト単位の依存関係ビュー `lnge_vw_t_object_dependency`（SQLのみ）

- **要件**：テーブル／ビューだけの依存関係を持つビューが欲しい。カラム情報は
  `ARRAY<STRUCT>` で畳み込む。**推移的依存**（`impact_rank` を持つ）、出力先は
  **Looker Studio**（配列を読めないので文字列版も併設）、**EPHEMERAL / FAILED は除外**し
  03 の `DECLARE` で解析対象にした範囲だけを載せる。
- **元データの選択**：`lnge_vw_t_column_usage_impact` ではなく `lnge_t_impact` から作る。
  - usage 表は「物理カラムまで解決できた参照」しか持たないので、カラムが解決できなかった
    オブジェクト間の辺が落ちる。
  - usage を join すると経路×利用箇所で行が増え、`ARRAY_AGG` が汚れる。
  - `lnge_t_impact` は既に「経路 1 本 = 1 行」で、推移的到達がそのまま入っている。
- **2 段階ロールアップ**：`ARRAY_AGG(DISTINCT <struct>)` は BigQuery で使えないため、
  まず (オブジェクトペア × カラムペア) 粒度に集約してから、オブジェクトペア粒度で
  `ARRAY_AGG` する。**この 1 段目が配列の重複排除そのもの**（経路違いの同一カラムペアが
  何本あっても要素は 1 つ）。`impact_rank` は `MIN`（最短ホップ）、`max_impact_rank` も併設。
- **rank は起点相対**（`vw_column_usage_impact` の `depth` と同じ）。impact は全 edge を
  再帰の base case にするので**全ノードが origin になり得る**。同じ影響先でも起点が変われば
  rank が変わる（`A → B → C` で、起点 A なら C は rank 2、起点 B なら C は rank 1）。
  レポート側は必ず起点を 1 つ絞ってから rank を読むこと。
- **除外の効き方**：端点が EPHEMERAL / 非アクティブ / 未 COMPLETED なら除外。ただし
  **除外オブジェクトを「経由する」経路は残る**（impact は中間ノードを `dependency_path`
  の中にしか持たないので、端点だけ落としても到達関係は生きる）。逆に、参照されるだけで
  解析対象ではない上流（生のソース表）は registry に行が無いので **残し**、
  `origin_is_analysis_target = FALSE` で印を付ける。落とすと「外から解析対象領域に入る辺」が
  全部消えるため。
- **registry join の fan-out 防止**：registry を (project, dataset, name) で 1 行に
  集約してから LEFT JOIN する。`object_type` は join キーにしない（impact 側の型は
  解析器が見た型で、registry の型と一致するとは限らない）。
- **Looker Studio 対応**：`column_dependencies` / `shortest_object_path` の配列に対して
  `column_dependencies_text` / `origin_columns_text` / `impacted_columns_text` /
  `shortest_object_path_text` を併設。配列でデータソース作成に失敗する場合は
  `SELECT * EXCEPT (...)` で外す。
- **経路の畳み込み**：`dependency_path` の要素は `project.dataset.object.column`。
  末尾のカラム部分を落とし、連続する同一オブジェクトを 1 ホップに畳んで
  `shortest_object_path` にしている。
- エンジン変更なし（バンドル・GCS 再デプロイ不要）。01 を `recreate_views_only = TRUE` で
  流すだけで反映できる。レポート作成者向けのカラム定義書は
  `docs/VIEW_OBJECT_DEPENDENCY.md`。

## 4.33 レポート用ビューの static 化（03 STEP 4b・SQLのみ）

- **動機**：2つのレポートビューは読むたびに impact 全体を集計し直す。さらに Looker Studio 側の
  フィルタは `origin_full_name`（`CONCAT` の計算列）に当たるため、`lnge_t_impact` の
  クラスタリングによるプルーニングも効かない。
- **BigQuery の MATERIALIZED VIEW は使っていない**（そもそも使えない）：`ARRAY_AGG(... ORDER BY ...)` /
  `STRING_AGG(DISTINCT ...)` / LEFT JOIN / 分析関数 / 相関 ARRAY サブクエリのいずれも
  BigQuery のマテビューが受け付けない。よって通常テーブルへの `CREATE OR REPLACE TABLE ... AS
  SELECT *`。
- **命名**：ビュー名から `vw_` を落とす。
  `lnge_vw_t_column_usage_impact` → `lnge_t_column_usage_impact`、
  `lnge_vw_t_object_dependency` → `lnge_t_object_dependency`。
- **正本はビュー**：`SELECT *` で作るので、01 でビューを直せば次回実行でテーブルのスキーマも
  追従する（二重管理しない）。各行に `refreshed_at` を付与。
- **再構築条件**：STEP 4 と同じ（`has_analysis_work OR orphan_direct_dep_deleted > 0`）＋
  **テーブル未作成なら作る**。後者が無いと「ビューをデプロイした直後の、何も変わらない実行」で
  テーブルが作られず、レポートの参照先が無い状態になる。`preview_only` では実行しない。
- **失敗はパイプラインを止めない**：派生データであり、想定される原因は 01 が古くビューが
  無いこと。`REFRESH_STATIC_REPORT_TABLES / FAILED` 行と対処ヒントを出すだけ。
- **挙動差は1点だけ**：`usage_definition_html` のハイライトは
  `ARRAY_AGG OVER (PARTITION BY 起点カラム, 利用オブジェクト, 定義)` で集める。分析関数は
  WHERE の後に評価されるので、**ビュー経由ならレポートの追加フィルタにハイライトが追従**するが、
  static テーブルでは作成時に確定する。パーティションキーに起点カラムと対象オブジェクトが
  入っているため通常用途では同結果。追従が必要なレポートだけビューを読む。
- **サイズ**：`usage_definition_text` / `usage_definition_html` はオブジェクトの SQL 全文を
  行ごとに繰り返す（1行 = 起点カラム × 利用箇所 × 経路）。
  `static_tables_include_usage_sql = FALSE` で static テーブルから外せる。

## 4.22 本ドキュメントと実装の乖離（重要）

`docs/SESSION_HANDOFF.md` の §1〜§4.20 は **1.5.0-032 の途中まで**しか追随していない。
その後 CHANGELOG に追記された変更（テスト `test_v1_5_0_061`〜`073` に対応）は本書に
節が無い。**経緯を追うときは `CHANGELOG.md` の冒頭から読むのが正**（本書は
「なぜそう決めたか」の補助資料と割り切る）。§4.20 以降で入っている主なもの：

- §4.21 のデータセット単位ループ＋メタデータ走査の絞り込み＋無変更時スキップ（SQL）
- `script_variables` オプション（親スクリプトの `DECLARE` 変数を子ジョブ SQL の解析に渡す）
  … `test_v1_5_0_067`
- 位置パラメータ `?` の PARAMETER トークン化 … `test_v1_5_0_066`
- `UNNEST` 配列引数の可視範囲を先行ソースへ限定（誤 AMBIGUOUS 解消）… `test_v1_5_0_065`
- 相関 UNNEST の非修飾配列引数の解決 … `test_v1_5_0_063`
- HAVING EXISTS 内の相関 UNNEST が外側集約エイリアスを指す形 … `test_v1_5_0_062`
- 消えた一時テーブル参照を ERROR ではなく WARNING にする判定 … `test_v1_5_0_064`
- FROM 位置の `EXTERNAL_QUERY` / TVF を不透明ソースとして解析 … `test_v1_5_0_068`
- `column_usages` エクスポート追加（全句の解決済み物理カラム参照を1参照=1行で出力）
  … `test_v1_5_0_069`
- FROM サブクエリが `WITH` / セット演算で始まる形 … `test_v1_5_0_070`
- 式パーサのエラーに位置情報を付与 … `test_v1_5_0_071`
- 無型 STRUCT のフィールド別名 … `test_v1_5_0_072`
- CTE の後ろの括弧付きメインQuery … `test_v1_5_0_073`（本セッション）
- 括弧付き branch が自身のセット演算/CTE を含む形 … `test_v1_5_0_074`（本セッション）
- 定義ソース種別フィルタ `analysis_include_generation_types`（§4.23・本セッション、SQLのみ）
- ソースデータセットのアクセス事前チェック（§4.24・本セッション、SQLのみ）
- 03 実行前の対象確認 `preview_only`（§4.25・本セッション、SQLのみ）
- `{project_token}` を `source_project_filters` / SA 配列へ拡張（§4.26・本セッション、SQLのみ）
- column usage impact ビューの `line_text` トリム＋01 の `recreate_views_only`（§4.27・本セッション、SQLのみ）
- 使用箇所つき SQL の HTML 描画 UDF（§4.28・本セッション、SQLとツールのみ）
- SQL 追加：`sql/maintenance/08_view_last_access.sql`、
  `sql/maintenance/09_unanalyzed_object_definitions.sql`、
  `definition_registry` の `labels` 列（§4.12）

## 5. 現在地（2026-08-22 更新）

- リポジトリ: `audeoinc/share` の `lineage/`。ブランチ `claude/lineage-project-resume-tqwrp9`。
- バージョン表記: `1.5.0-032`（`release_manifest.json` / `package.json`）。
  テスト番号は版数と独立で、現在 `test_v1_5_0_074` まで。
- バンドル: `sha256 = d7992396d38f568b6d30a44ac7d75183f4563e0f2c22f867a9d7e87d8bee5372`、`465176` bytes
  （`release_manifest.json` と一致）。
- テスト: `test:release` **54 本 PASS** / ゴールデン（`test_v1_5_0_003`）48 ケース PASS。
- 03 STEP 3：**データセット単位ループ ＋ 周回内フルバッチ**（§4.21）。チャンク分割は撤去済み。
- **BigQuery 実機検証は未完了**。§4.5 のバッチ化、§4.6、§4.21 の各変更はいずれも未検証。
  本番前に staging 実行と旧実装との出力 diff（direct_dependency / lineage_diagnostic /
  definition_registry）で確認すること。
- **デプロイ時**：エンジンを変更しているため GCS の `lineage_udf_bundle.js` を再アップロード。

## 6. Claude Code で続きを進める手順

1. このリポジトリ一式をローカルの作業ディレクトリ（Git 管理下）に展開する。
2. Claude Code をそのディレクトリで起動する（`CLAUDE.md` が自動で読み込まれる）。
3. 最初に `CHANGELOG.md` 冒頭と本 `docs/SESSION_HANDOFF.md` を読ませて経緯を把握させる。
4. 変更は §4（CLAUDE.md）の必須手順に従う：実装 → 番号付き回帰テスト追加 →
   `test:release` / ゴールデン緑 → エンジン変更なら再ビルド + `release_manifest.json` 更新。
