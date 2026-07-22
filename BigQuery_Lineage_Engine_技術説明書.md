# BigQuery Lineage Engine 技術説明書

## 1. プロジェクト概要

本プロジェクトの目的は、BigQuery VIEW の SQL
を解析し、物理テーブル・物理カラムまで依存関係を展開して、列レベル(Lineage)の影響分析を可能にすることです。

最終的な利用イメージは次のとおりです。

    Root Table + Column
            │
            ▼
    Lineage Engine
            │
            ▼
    影響を受けるVIEW
    影響を受けるカラム
    影響ランク(Rank)
    依存経路(Path)

利用例

-   テーブル変更影響調査
-   カラム削除影響調査
-   Lookerレポート
-   リリース影響確認

------------------------------------------------------------------------

# 2. 全体アーキテクチャ

    View Definition
          │
          ▼
    Lexer
          │
          ▼
    TokenReader
          │
          ▼
    Clause Parser
          │
          ▼
    Expression Parser
          │
          ▼
    AST
          │
          ▼
    Dependency Resolver
          │
          ▼
    Physical Column Resolver
          │
          ▼
    Repository Tables
          │
          ▼
    Looker SQL

各処理は責務を明確に分離しています。

------------------------------------------------------------------------

# 3. JavaScript構成

## Lexer

役割

-   SQL文字列をTokenへ分解
-   コメント除去
-   括弧深度管理
-   行番号・列番号保持

出力

    Token[]

------------------------------------------------------------------------

## TokenReader

役割

-   Tokenの読み進め
-   peek
-   advance
-   rewind
-   TokenSeq生成
-   findMatchingCloseParenthesis()

ParserはSQL文字列を直接読まず、TokenReader経由で解析します。

------------------------------------------------------------------------

## ClauseParser

句単位を担当します。

例

-   SELECT
-   FROM
-   WHERE
-   GROUP BY
-   HAVING
-   QUALIFY
-   ORDER BY

------------------------------------------------------------------------

## ExpressionParser

式解析専用です。

解析例

    SUM(amount)

    CASE WHEN

    CAST()

    Function

    Arithmetic

    Subquery

AST生成はAstFactoryへ委譲しています。

------------------------------------------------------------------------

## AstFactory

役割

-   NodeType定義
-   AST生成
-   AST検証

ParserはAST生成方法を意識しません。

------------------------------------------------------------------------

## Resolver群

ResolverはASTから依存関係を解決します。

例

-   AliasResolver
-   SourceResolver
-   PhysicalColumnResolver

責務を細かく分割しています。

------------------------------------------------------------------------

# 4. Repository構成

主要テーブル

-   lineage_definition_registry
-   lineage_direct_dependency
-   lineage_impact
-   lineage_diagnostic

## lineage_impact

Lookerレポートで利用する中心テーブルです。

保持内容

-   Root Table
-   Root Column
-   Impacted View
-   Impacted Column
-   Rank
-   Dependency Path

------------------------------------------------------------------------

# 5. SQL処理

Repository作成SQL

役割

-   Repository更新
-   Dependency生成
-   Rank計算
-   Recursive展開

Looker用SQL

役割

-   Root Table指定
-   Root Column指定
-   Impact View取得
-   Impact Column取得

今後追加予定

-   impact_type
-   dependency_usage_type
-   dependency_path_display

------------------------------------------------------------------------

# 6. クラス設計方針

-   1クラス1責務
-   Parserは解析のみ
-   AST生成はAstFactory
-   Resolverは依存解決専用
-   SQL生成処理は持たない

------------------------------------------------------------------------

# 7. Build Everything

役割

-   Bundle生成
-   回帰試験
-   release_manifest.json生成
-   ZIP生成

デプロイは手動運用を前提とします。

------------------------------------------------------------------------

# 8. 今後のロードマップ

Phase1（完了）

-   Lexer
-   Parser
-   AST
-   Repository
-   Diagnostic
-   Build Everything

Phase2

-   LookerレポートSQL
-   影響分析画面
-   利用実績連携

Phase3

-   LTS品質パッケージ
-   業務要件
-   設計書
-   SQL一覧
-   期待結果
-   実行結果

------------------------------------------------------------------------

# 9. チーム向けメッセージ

本プロジェクトではJavaScriptを採用していますが、一般的なWebアプリケーションを開発しているわけではありません。

JavaScriptは「SQLを解析するエンジン」を実装するための実装言語として利用しています。

Parser・AST・Resolverというコンパイラ技術を取り入れていますが、それぞれの責務を分離しているため、各クラスは比較的シンプルな構造となっています。

JavaScriptに不慣れなメンバーでも、「Lexer → Parser → AST →
Resolver」というデータの流れを理解すると、全体像を把握しやすくなります。

今後はLookerレポートを中心とした利用者向け機能を充実させ、データ変更時の影響分析を迅速に行える基盤として運用していく予定です。
