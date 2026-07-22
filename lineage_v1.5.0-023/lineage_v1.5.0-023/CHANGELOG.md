# v1.5.0-021

- Diagnosticへ`scope_type`を自動補完。
- `candidate_source_name(s)`と`resolved_source_name`を追加。
- `sql_context`を対象SELECT項目のAST Token範囲から生成。
- 診断補完の回帰テストを追加。

# v1.5.0-020

- Preserve `diagnostic_json` even when `compact_export = TRUE`.
- Suppress derived `LINEAGE_PARTIALLY_RESOLVED` warnings when the same unresolved dependency already has an ERROR diagnostic.
- Add scope and token location details to physical-column diagnostics.
- Verify `error_nodes_json` and compact diagnostics through regression tests.

## 1.5.0-019

- Added `DiagnosticEngine` as the central diagnostic policy and formatting component.
- Added common node, scope, token position, SQL fragment, SQL context, and original SQL fields.
- Added `error_nodes` to engine results and `error_nodes_json` to exported analysis rows.
- Added a dedicated `error_nodes_json` column to non-completed daily pipeline results.
- Added regression test `test_v1_5_0_019.js`.

## 1.5.0-018

- `EXPRESSION_SUBQUERY`内部の無名SELECT出力を`OUTPUT_COLUMN_NAME_UNRESOLVED`の対象外に変更。
- スカラ集約サブクエリと`EXISTS (SELECT 1 ...)`の回帰テストを追加。
- 外側の公開列名と物理カラムリネージは従来どおり保持。

## 1.5.0-017

- Added shared SELECT output-alias resolution for GROUP BY, HAVING, QUALIFY, and ORDER BY.
- Kept WHERE and JOIN ON from resolving SELECT output aliases.
- Promoted diagnostic output into the formal `03_run_daily_lineage_pipeline.sql`.
- Treats only `COMPLETED` as normal during stabilization and returns every other UDF result in the final SELECT.
- Moved generated JavaScript from `build` to `dist`.
- Moved BigQuery helper SQL from `javascript/bigquery` to `sql/bigquery`.
- Removed `javascript/legacy` and the separate debug pipeline.

# Changelog

## [1.5.0-016] - 2026-07-22

### Fixed

- Resolved fields referenced through a correlated `UNNEST` alias to the original physical STRUCT/ARRAY field path.
- Preserved support for conditionless correlated `LEFT JOIN UNNEST` and `ON TRUE`.
- Added the full UDF result JSON to the final debug result set when analysis is not publishable.

### Tests

- Added `test_v1_5_0_016.js` covering `CONTACTS.CONTACT_VALUE` resolution for both JOIN forms.
- Passed the 46-case Golden regression suite and bundle verification.

## 1.5.0-015 - 2026-07-22

- Allow conditionless `LEFT JOIN UNNEST(...)` only when the UNNEST expression is correlated to a previously visible FROM source.
- Preserve the ON/USING requirement for ordinary LEFT JOIN sources.
- Confirm explicit `ON TRUE` support for correlated LEFT JOIN UNNEST.
- Add parser regression test and sample View `v_customer_primary_contact_on_true`.


## [Unreleased]

### Fixed

- Moved per-object analysis variables into an outer `BEGIN` block.
- Wrapped the replace-and-restore operation in an inner `BEGIN ... EXCEPTION` block.
- Fixed `Unrecognized name: replacement_started` caused by BigQuery exception-handler variable scope.


### Changed

- Centralized every dynamic identifier substitution in the temporary SQL function `render_dynamic_sql()`.
- Removed intermediate identifier variables including `repository_identifier`, `target_identifier`, `target_project_identifier`, and `udf_identifier`.
- Standardized all dynamic SQL blocks to: template, render, unresolved-placeholder assertion, and execution.
- Continued to pass runtime values through `EXECUTE IMMEDIATE ... USING`.


### Fixed

- Fully qualified all three daily-pipeline `MERGE` targets with the `__REPOSITORY__` placeholder.
- Added `repository_identifier = repository_project_id || '.' || repository_dataset`.
- Added unresolved-placeholder assertions before repository `MERGE` execution.


### Changed

- Unified dynamic identifier construction in `03_run_daily_lineage_pipeline.sql` using named placeholders and `REPLACE()`.
- Added `__TARGET__`, `__TARGET_PROJECT__`, `__JOB_REGION__`, and `__UDF__` placeholders.
- Retained `USING` parameters for runtime values such as lookback days and UDF arguments.
- Added unresolved-placeholder assertions before every dynamic SQL execution.


### Changed

- `03_run_daily_lineage_pipeline.sql` now declares repository project, repository dataset, target project, target dataset, job region, UDF location, parser strict mode, and maximum impact rank at the beginning of the script.
- The daily pipeline no longer reads scalar environment settings from `lineage_config`.
- Repository tables use `@@dataset_project_id` and `@@dataset_id`; dynamic identifiers for metadata and UDF calls use `EXECUTE IMMEDIATE`.
- Scheduled Query and DAG service-account arrays remain managed in `lineage_execution_account_config`.


### Fixed

- Removed the unsupported `NOT NULL` constraint from the `ARRAY<STRING>` service account column. Non-empty arrays remain enforced by setup assertions and validation checks.

### Fixed

- Changed dynamic configuration reads from `SELECT AS STRUCT` to a single explicit `STRUCT(...)` column so `EXECUTE IMMEDIATE ... INTO config` receives exactly one column.

### Planned

- JavaScript source and regression fixtures
- Actual execution evidence
- Looker Studio operational dashboard
- Retention and cleanup policy
- CI workflow
- License selection

## [1.0.0-lts-udf.1] - 2026-07-21

### Added

- Recovered 23 JavaScript source files from canonical bundle source markers
- Formal source directories for AST, lexer, token reader, parsers, resolvers, exporter, and engine
- Reproducible UDF bundle build script
- Canonical legacy bundle behavior verification
- 46-case Golden parser and lineage regression suite
- Performance regression contract and runner
- BigQuery UDF smoke-test SQL assets
- Supported SQL coverage and regression test design documents

## [1.0.0-lts-docs.1] - 2026-07-21

### Added

- Environment setup SQL
- Sample environment SQL
- Integrated daily pipeline
- Validation SQL
- Repository integration test
- Changed-object analysis SQL
- Execution account configuration using `ARRAY<STRING>`
- Business requirements
- Architecture and system design
- SQL and UDF design
- Operation and troubleshooting guides
- Development guide
- ER diagram
- Initial ADR set

## 1.5.0-022

- Build Everything v1を追加。
- bundle生成、bundle検証、リリース回帰、成果物ステージング、ZIP生成を1コマンドに統合。
- `release_manifest.json`を追加し、version、SHA-256、テスト状態、成果物、デプロイ状態を記録。
- `--deploy`指定時のみGCSアップロードとBigQuery UDF更新を実行する安全な方式を採用。
- ZIPファイル名とトップレベルフォルダ名の一致を自動保証。

## 1.5.0-023

- Added `looker/sql/01_query_column_impact.sql`.
- Added `impact_type`, `dependency_usage_type`, and `dependency_path_display` to the downstream column impact report.
- Added `impacted_expression` to support manual impact review.
- Documented the current clause-level `usage_type` limitation.
