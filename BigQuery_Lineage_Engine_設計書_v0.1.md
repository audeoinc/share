# BigQuery Lineage Engine 設計書（ドラフト v0.1）

> 本書は BigQuery Lineage Engine の正式設計書です。
> 本版では以下を対象とします。
>
> 1.  システム概要
> 2.  Repository設計
> 3.  JavaScriptエンジン設計

------------------------------------------------------------------------

# 1. システム概要

## 1.1 開発背景

企業のデータ基盤では、物理テーブルのカラム変更が多数のVIEWへ波及します。
BigQuery標準では列レベル(Lineage)の影響を網羅的に取得することが難しいため、
独自のSQL解析エンジンをJavaScript UDFで実装しました。

## 1.2 解決したい課題

-   物理カラム変更時の影響VIEW特定
-   影響カラム特定
-   依存経路の可視化
-   Looker等への影響分析
-   リリース前レビュー支援

## 1.3 全体構成

``` text
INFORMATION_SCHEMA.VIEWS
            │
            ▼
      SQL Definition
            │
            ▼
         JavaScript Engine
            │
   ┌────────┴─────────┐
   ▼                  ▼
Diagnostic        Dependency
                      │
                      ▼
             Physical Resolution
                      │
                      ▼
             Repository Tables
                      │
                      ▼
               Looker SQL
```

## 1.4 データフロー

1.  VIEW定義取得
2.  Lexerでトークン化
3.  ParserでAST生成
4.  Resolverで依存関係解決
5.  Physical Resolverで物理カラムへ展開
6.  Repository更新
7.  Looker用SQLから検索

------------------------------------------------------------------------

# 2. Repository設計

## 2.1 基本思想

Repositoryは解析結果を永続化し、解析処理と参照処理を分離します。

## 2.2 主テーブル

  テーブル                      役割
  ----------------------------- --------------------
  lineage_definition_registry   解析対象管理
  lineage_direct_dependency     直接依存
  lineage_impact                Rootからの影響分析
  lineage_diagnostic            診断情報

## 2.3 lineage_impact

主要列

-   origin_project
-   origin_dataset
-   origin_object
-   origin_column
-   impacted_project
-   impacted_dataset
-   impacted_object
-   impacted_column
-   impact_rank
-   dependency_path

利用例

-   Root TABLE検索
-   Root COLUMN検索
-   Lookerレポート

## 2.4 データフロー

``` text
VIEW
 │
 ▼
direct_dependency
 │
 ▼
recursive expansion
 │
 ▼
lineage_impact
```

## 2.5 設計方針

-   正規化し過ぎない
-   レポート検索を優先
-   Root検索を高速化
-   Recursiveは事前計算

------------------------------------------------------------------------

# 3. JavaScriptエンジン設計

## 3.1 全体構成

``` text
Lexer
  │
TokenReader
  │
ClauseParser
  │
ExpressionParser
  │
AstFactory
  │
Resolver群
  │
Diagnostic
```

各クラスは単一責務とします。

## 3.2 Lexer

責務

-   Token生成
-   コメント除去
-   行番号保持
-   列番号保持
-   括弧深度管理

出力

    Token[]

## 3.3 TokenReader

責務

-   advance()
-   rewind()
-   peek()
-   TokenSeq生成
-   findMatchingCloseParenthesis()

ParserはTokenReaderのみを利用します。

## 3.4 ClauseParser

担当句

-   SELECT
-   FROM
-   WHERE
-   GROUP BY
-   HAVING
-   QUALIFY
-   ORDER BY

Clause単位でASTを構築します。

## 3.5 ExpressionParser

担当

-   Function
-   CASE
-   CAST
-   Arithmetic
-   SubQuery
-   Window

ExpressionParserは解析のみ行い、AST生成はAstFactoryへ委譲します。

## 3.6 AstFactory

責務

-   NodeType定義
-   Node生成
-   Validation

ParserはNode生成方法を持ちません。

## 3.7 Resolver

構成

-   AliasResolver
-   SourceResolver
-   PhysicalColumnResolver

責務

-   Alias解決
-   Source解決
-   Physical Column展開

## 3.8 Diagnostic

解析途中で発生した問題をJSONとして保存します。

主な情報

-   error_code
-   severity
-   sql_context
-   candidate_source
-   resolved_source
-   scope_type

## 3.9 クラス依存図

``` text
Lexer
  │
TokenReader
  │
ClauseParser
  │
ExpressionParser
  │
AstFactory
  │
Resolver
  │
Repository
```

依存方向は一方向とし、循環参照を避けます。

------------------------------------------------------------------------

# 次版予定

-   AST詳細設計
-   NodeType一覧
-   Resolver内部アルゴリズム
-   Physical Resolution
-   Diagnostic Framework詳細
-   Repository SQL詳細
-   Build Everything
-   Lookerレポート設計
