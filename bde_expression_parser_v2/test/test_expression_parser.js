"use strict";

const assert = require("node:assert/strict");
const { tokenize } = require("../src/lexer");
const { ExpressionParser, NodeType } = require("../src/expression_parser");
const { AstFactory } = require("../src/ast_factory");

/**
 * SQL式をToken化してASTへ変換する。
 * 各テストの準備処理を共通化し、検証内容へ集中できるようにする。
 */
function parse(sqlExpression) {
  const tokens = tokenize(sqlExpression);
  const parser = new ExpressionParser(tokens);
  return parser.parseExpression();
}

/* 乗算が加算より先にまとまることを確認する。 */
{
  const ast = parse("a + b * c");
  assert.equal(ast.node_type, NodeType.ARITHMETIC_EXPRESSION);
  assert.equal(ast.operator, "+");
  assert.equal(ast.right.operator, "*");
}

/* ANDがORより優先されることを確認する。 */
{
  const ast = parse("a = 1 OR b = 2 AND c = 3");
  assert.equal(ast.node_type, NodeType.LOGICAL_EXPRESSION);
  assert.equal(ast.operator, "OR");
  assert.equal(ast.right.operator, "AND");
}

/* BETWEEN内部のANDと論理ANDを区別する。 */
{
  const ast = parse("amount BETWEEN 10 AND 20 AND active = TRUE");
  assert.equal(ast.operator, "AND");
  assert.equal(ast.left.node_type, NodeType.BETWEEN_EXPRESSION);
  assert.equal(ast.left.lower_bound.value, "10");
  assert.equal(ast.left.upper_bound.value, "20");
}

/* IS DISTINCT FROMとIS NOT DISTINCT FROMを専用Nodeで保持する。 */
{
  const ast = parse("old_value IS DISTINCT FROM new_value");
  assert.equal(ast.node_type, NodeType.DISTINCT_FROM_EXPRESSION);
  assert.equal(ast.negated, false);

  const negatedAst = parse("old_value IS NOT DISTINCT FROM new_value");
  assert.equal(negatedAst.node_type, NodeType.DISTINCT_FROM_EXPRESSION);
  assert.equal(negatedAst.negated, true);
}

/* searched CASEを解析する。 */
{
  const ast = parse("CASE WHEN amount > 0 THEN amount ELSE 0 END");
  assert.equal(ast.node_type, NodeType.CASE_EXPRESSION);
  assert.equal(ast.case_operand, null);
  assert.equal(ast.when_clauses.length, 1);
  assert.equal(ast.when_clauses[0].condition.operator, ">");
  assert.equal(ast.else_expression.value, "0");
}

/* simple CASEを解析する。 */
{
  const ast = parse("CASE status WHEN 'A' THEN 1 WHEN 'B' THEN 2 ELSE 0 END");
  assert.equal(ast.node_type, NodeType.CASE_EXPRESSION);
  assert.equal(ast.case_operand.name, "status");
  assert.equal(ast.when_clauses.length, 2);
}

/* IF内のIFは同じExpression Parserの再帰で解析できる。 */
{
  const ast = parse("IF(flag, IF(amount > 0, amount, 0), NULL)");
  assert.equal(ast.node_type, NodeType.FUNCTION_CALL_EXPRESSION);
  assert.equal(ast.arguments[1].node_type, NodeType.FUNCTION_CALL_EXPRESSION);
}

/* EXISTSとNOT EXISTSを専用Nodeへ変換する。 */
{
  const ast = parse("EXISTS (SELECT 1 FROM sales)");
  assert.equal(ast.node_type, NodeType.EXISTS_EXPRESSION);
  assert.equal(ast.negated, false);
  assert.equal(ast.subquery.node_type, NodeType.SUBQUERY_EXPRESSION);
  assert.equal(Array.isArray(ast.subquery.query_ast.clauses), true);

  const negatedAst = parse("NOT EXISTS (SELECT 1 FROM sales)");
  assert.equal(negatedAst.node_type, NodeType.EXISTS_EXPRESSION);
  assert.equal(negatedAst.negated, true);
}

/* INサブクエリにもquery_ast概要が付与される。 */
{
  const ast = parse("customer_id IN (SELECT customer_id FROM customers)");
  assert.equal(ast.values.node_type, NodeType.SUBQUERY_EXPRESSION);
  assert.equal(Array.isArray(ast.values.query_ast.select_items), true);
}

/* ARRAY(...)とSTRUCT(...)は関数形式のExpressionとして扱う。 */
{
  const arrayAst = parse("ARRAY(1, 2, 3)");
  assert.equal(arrayAst.node_type, NodeType.FUNCTION_CALL_EXPRESSION);
  assert.equal(arrayAst.function_name, "ARRAY");

  const structAst = parse("STRUCT(a, b)");
  assert.equal(structAst.function_name, "STRUCT");
}

/* AstFactoryが壊れたNodeTypeを拒否することを確認する。 */
{
  assert.throws(() => {
    AstFactory.createBinary(undefined, "+", { node_type: "X" }, { node_type: "Y" });
  }, TypeError);
}

console.log("ExpressionParser v2 tests passed.");
