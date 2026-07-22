# BigQuery Lineage Engine Design Document

**Document version:** 0.2  
**Implementation baseline:** lineage v1.5.0-023  
**Language:** Japanese  
**File names:** English only

## Purpose

本書は、BigQuery Lineage Engine の構造、設計意図、JavaScript内部処理、Repository、および運用SQLを、開発・保守・レビューに参加するメンバーが理解できる粒度で説明する正式設計書です。

JavaScriptやParser実装に慣れていない読者も対象とし、用語の説明、入力と出力、処理順序、図、実例を併記します。

## Current chapters

1. [System Overview](01_System_Overview.md)
2. [Repository Design](02_Repository_Design.md)
3. [JavaScript Engine](03_JavaScript_Engine.md)

## Planned chapters

4. AST Design  
5. Resolver Design  
6. Repository Pipeline  
7. Diagnostic Framework  
8. Looker Report Design  
9. Release and Operations  
10. Test Strategy  
11. Appendix and Glossary

## Reading guide

初めて読む場合は、第1章から順番に読むことを推奨します。

JavaScriptコードのレビューを担当する場合は、第1章を読んだ後、第3章へ進んでください。Repository SQLやLookerレポートを担当する場合は、第1章、第2章の順で読むと理解しやすくなります。

## Scope of this version

本版は以下を対象とします。

- 開発背景と解決対象
- システム境界と全体データフロー
- Repositoryの役割と主要テーブル
- JavaScriptエンジンのクラス構成
- LexerからImpactResolverまでの実行順
- BigQuery UDFとSQL処理の接続点

ASTの全NodeType、各Resolverの詳細アルゴリズム、Diagnosticコード一覧は後続版で詳細化します。
