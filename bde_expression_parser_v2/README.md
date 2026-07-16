# BDE Expression Parser v2

JavaScript版のExpression Parserです。

## v2の追加内容

- `ast_factory.js`へAST生成と検証を分離
- `NodeType`を`Object.freeze()`で固定
- `CASE WHEN ... THEN ... ELSE ... END`
- simple CASE
- `EXISTS` / `NOT EXISTS`
- `IS DISTINCT FROM` / `IS NOT DISTINCT FROM`
- サブクエリへClause/SELECT概要の`query_ast`を付与
- `ARRAY(...)` / `STRUCT(...)`の関数形式

## 実行

```bash
node test/test_expression_parser.js
node test/test_token_reader.js
node test/test_clause_parser.js
node test/test_select_parser.js
```

位置情報はすべて`token_seq`基準です。
