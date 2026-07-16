# BDE Expression Parser v1

## 概要

BigQuery SQLの式を、`token_seq`位置情報付きASTへ変換する基本版です。

## 対応範囲

- `OR`, `AND`, 前置`NOT`
- `=`, `!=`, `<>`, `<`, `<=`, `>`, `>=`
- `IN`, `NOT IN`
- `BETWEEN`, `NOT BETWEEN`
- `IS NULL`, `IS NOT NULL`, `IS TRUE`, `IS FALSE`
- `||`, `+`, `-`, `*`, `/`, `%`
- 識別子、修飾識別子、Wildcard
- 数値、文字列、NULL、TRUE、FALSE
- 関数呼び出し
- 括弧式
- INサブクエリの範囲保持

`CASE`とサブクエリ内部の再帰Query解析はv2以降の対象です。

## 実行

```bash
node test/test_expression_parser.js
```

既存テストは`test`ディレクトリから実行してください。
