# SESSION_HANDOFF — 1.5.0-032 の意思決定と経緯

このドキュメントは、対話セッションで行った設計判断とその「理由」を、後続の
Claude Code セッション（会話の記憶を持たない）へ引き継ぐためのものです。各項目の
「何を・なぜ」を残しています。実装の要約は `CHANGELOG.md`、規約は `CLAUDE.md` /
`docs/DEVELOPMENT_GUIDE.md` を参照してください。

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
- 実装：`fingerprint_lineage_sql` UDF（01）と `fingerprintSqlForBigQuery`（エンジン）。
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
- 冗長変数の整理：`render_dynamic_sql` の未使用プレースホルダ `__REPOSITORY__` /
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

## 5. 現在地（引き継ぎ時点）

- バンドル: `sha256 = 8b458f3b1f00edf1176aca9c93fbfc583bdddf51b2a4c352832de943f3b390f0`、`418298` bytes
- `test:release` 28 本 PASS / ゴールデン 48 ケース PASS
- 二本ツリー（-031 / -032）同期済み
- 03 STEP 3：フルバッチ化済み（上記 §4.5 ①②③）。集合ベースに全面置換、ジョブ数は
  N 非依存。**BigQuery 未検証**（本番前に staging 実行＋旧ループとの出力 diff が必要）。

## 6. Claude Code で続きを進める手順

1. このリポジトリ一式をローカルの作業ディレクトリ（Git 管理下）に展開する。
2. Claude Code をそのディレクトリで起動する（`CLAUDE.md` が自動で読み込まれる）。
3. 最初に `CHANGELOG.md` 冒頭と本 `docs/SESSION_HANDOFF.md` を読ませて経緯を把握させる。
4. 変更は §4（CLAUDE.md）の必須手順に従う：実装 → 番号付き回帰テスト追加 →
   `test:release` / ゴールデン緑 → エンジン変更なら再ビルド + `release_manifest.json` 更新。
