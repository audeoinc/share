# BigQuery Physical Lineage Repository

BigQuery上のView、Scheduled Query、DAG生成テーブルを対象に、SQL定義を解析して物理テーブルのカラムから下流オブジェクトのカラムまでの依存関係を管理するリポジトリです。

## 解決する課題

BigQueryのメタデータだけでは、複数段のView、CTE、JOIN、集約、`SELECT *`、STRUCT、`ARRAY<STRUCT>`を通過した物理カラムの影響範囲を、列単位で一貫して把握することが困難です。

本リポジトリは、定義変更の検知、JavaScript UDFによる解析、直接依存関係の永続化、Impactの多段展開、診断情報の保存を一つの運用フローとして提供します。

## 主な特徴

- View定義のハッシュによる変更検知
- Scheduled QueryとDAG生成テーブルの登録
- 複数サービスアカウントを`ARRAY<STRING>`で管理
- 物理カラムおよびネストしたfield pathの解決
- Direct Dependencyと多段Impactの分離
- 解析失敗時に旧Dependencyを保護
- 再実行可能なBigQueryスクリプト
- 検証SQLと総合試験SQLを同梱

## アーキテクチャ

```mermaid
flowchart LR
  A[INFORMATION_SCHEMA.VIEWS] --> R[Definition Registry]
  B[INFORMATION_SCHEMA.JOBS_BY_PROJECT] --> R
  C[Execution Account Config] --> B
  R -->|is_changed = true| U[JavaScript Lineage UDF]
  M[COLUMNS / COLUMN_FIELD_PATHS] --> U
  U --> D[Direct Dependency]
  U --> G[Diagnostic]
  D --> I[Impact]
  R --> V[Validation]
  D --> V
  I --> V
  G --> V
  V --> L[Looker Studio]
```

## クイックスタート

実行順:

1. `sql/setup/01_setup_lineage_environment.sql`
2. `sql/sample/02_setup_sample_environment.sql`
3. `sql/pipeline/03_run_daily_lineage_pipeline.sql`
4. `sql/validation/04_validate_lineage_environment.sql`
5. `tests/integration/05_repository_integration_test.sql`

セットアップ前に、GCSへJavaScript UDFライブラリを配置し、`01_setup_lineage_environment.sql`のBootstrap値を環境に合わせて変更してください。

## ディレクトリ

```text
docs/                 要件、設計、運用、ADR
javascript/           UDFソース、bundle、Golden・性能回帰試験
looker/               Looker Studio設計資産
sql/setup/            Repository初期構築
sql/sample/           サンプル環境
sql/pipeline/         日次処理
sql/validation/       環境検証
sql/maintenance/      個別解析・保守SQL
tests/integration/    総合試験
```

## 主要テーブル

- `lineage_config`
- `lineage_execution_account_config`
- `lineage_definition_registry`
- `lineage_direct_dependency`
- `lineage_impact`
- `lineage_diagnostic`
- `lineage_job_registry`

詳細は[System Design](docs/SYSTEM_DESIGN.md)を参照してください。

## 日次運用

通常の日次処理は次のSQLのみです。

```text
sql/pipeline/03_run_daily_lineage_pipeline.sql
```

実行後は`lineage_diagnostic`と`lineage_definition_registry.analysis_status`を確認します。

## 現在の状態

SQL、検証、総合試験、23個のJavaScriptソース、確定bundle、46件のGolden regression、性能回帰契約、LTSドキュメントを収録しています。実環境の実行結果、Looker Studio画面、ライセンスは導入環境で確定後に追加します。

## ライセンス

未選定です。公開前に、社内利用限定、Apache License 2.0、MIT Licenseなどから選定してください。

## Current package layout

- `javascript/src`: JavaScript parser and resolver source
- `javascript/dist`: generated BigQuery UDF bundle
- `javascript/test`: regression tests
- `sql/bigquery`: BigQuery helper SQL formerly stored under JavaScript
- `sql/pipeline/03_run_daily_lineage_pipeline.sql`: formal daily pipeline with final non-COMPLETED UDF result output

