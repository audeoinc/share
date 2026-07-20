# BigQuery Physical Lineage Repository
Version: 2026-07-21
Status: Definition Registry 完成 / Repository-UDF連携開発中

—

# 1. プロジェクト概要

BigQuery上で物理カラム単位(Lineage)の依存関係を解析し、
変更されたオブジェクトのみ再解析できるRepositoryを構築する。

最終目標

```
Physical Table
      │
      ▼
Definition Registry
      │
      ▼
Lineage UDF
      │
      ▼
Direct Dependency
      │
      ▼
Impact
```

Repository側が差分管理を担当し、
JavaScript UDFはSQL解析のみ担当する。

—

# 2. JavaScript UDF

ファイル

```
lineage_udf_bundle.js
```

Persistent UDF

```
analyze_lineage_json()
```

現在の状態

- Lexer完成
- Parser完成
- SourceResolver完成
- ColumnResolver完成
- PhysicalColumnResolver完成
- BigQueryExporter完成

Exporterは

```
analysis_id
```

必須。

analysis_id未指定だと

```
BigQueryExporter: analysis_id is required.
```

になる。

テスト用呼び出し例

```sql
SELECT
  audeodb.sample_ds.analyze_lineage_json(
      ‘analysis_test’,
      ‘SELECT customer_id FROM sample_ds.sales’,
      ‘[]’,
      ‘{}’,
      ‘{}’
  );
```

—

# 3. Repository

Dataset

```
audeodb.lineage_repository
```

テーブル

```
lineage_definition_registry
lineage_direct_dependency
lineage_impact
lineage_diagnostic
```

—

# 4. Registry同期

02

```
sync_view_registry
```

対象

```
INFORMATION_SCHEMA.VIEWS
```

03

```
sync_scheduled_ctas_registry
```

対象

```
Scheduled Query
```

ここまで完成。

Definition Registry件数

```
12
```

—

# 5. 現在のRepository状況

Definition Registry

```
12件
```

Direct Dependency

```
0件
```

Impact

```
0件
```

Diagnostic

```
0件
```

これは

Repository→UDF連携

が未実装なので正常。

—

# 6. Validation結果

v1.0.3

01〜05

すべて実行成功。

修正済み事項

- ARRAY NOT NULL
- CURRENT_TIMESTAMP
- DECLARE位置
- CLUSTER BY
- LOCATION指定

—

# 7. 発見した問題

lineage_impactを見ると

origin側が

```
AUDEODB
SAMPLE_DS
```

になっている。

一方

05_validation_queries.sql

では

```
audeodb
sample_ds
```

で検索しているため

一致しない。

実データ例

```
origin_project = AUDEODB
origin_dataset = SAMPLE_DS

impacted_project = audeodb
impacted_dataset = sample_ds
```

つまり

Exporter側で

Originだけ大文字

になっている。

Repository側でLOWERするか、

Exporter側で統一するか検討。

—

# 8. 添付ファイル

- lineage_impact出力サンプル
- 05_validation_queries.sql

これを元に修正予定。

—

# 9. 次に作成するSQL

```
06_analyze_changed_objects.sql
```

目的

Repositoryに登録されている

```
is_changed = TRUE
```

のみ解析する。

処理イメージ

```
Definition Registry
        │
        ▼
取得(is_changed=TRUE)
        │
        ▼
analyze_lineage_json()
        │
        ▼
JSON展開
        │
        ▼
lineage_direct_dependency更新
        │
        ▼
lineage_impact再構築
        │
        ▼
is_changed=FALSE
```

—

# 10. Repository完成後

Repository

↓

Scheduler

↓

変更検知

↓

UDF解析

↓

Impact更新

までを自動化する。

これにより

「物理カラム変更時の影響分析」

が高速に行える。

—

# 11. 開発方針

Repositoryが主体。

JavaScript側は

SQL解析エンジン

として固定。

Repositoryが

- 定義管理
- 差分管理
- スケジューリング
- Impact生成

を担当する。

今後の修正はRepository中心に行う。