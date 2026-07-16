"use strict";

const { AstFactory, NodeType } = require("./ast_factory");

/**
 * SQL式を演算子優先順位付きASTへ変換する再帰下降Parser。
 *
 * Public APIはparseExpression()のみ。privateメソッドの呼び出し階層が
 * SQL演算子の優先順位を表す。
 */
class ExpressionParser {
  constructor(tokens) {
    if (!Array.isArray(tokens)) {
      throw new TypeError("ExpressionParser: tokens must be an array.");
    }

    this.sourceTokens = tokens;
    this.tokens = [];
    this.index = 0;
  }

  parseExpression(startTokenSeq = null, endTokenSeq = null) {
    const expressionTokens = this.#selectExpressionTokens(startTokenSeq, endTokenSeq);

    /* 元Token配列は変更せず、Expression解析用配列だけからコメントを除く。 */
    this.tokens = this.#removeCommentTokens(expressionTokens);
    this.index = 0;

    if (this.tokens.length === 0) {
      throw new SyntaxError("ExpressionParser: expression contains no tokens.");
    }

    const expressionNode = this.#parseOrExpression();

    if (!this.#isEnd()) {
      const token = this.#current();
      throw new SyntaxError(
        `ExpressionParser: unexpected token "${token.token}" at token_seq ${token.token_seq}.`
      );
    }

    return expressionNode;
  }

  #parseOrExpression() {
    let leftNode = this.#parseAndExpression();

    while (this.#matches("OR")) {
      const operatorToken = this.#consume();
      const rightNode = this.#parseAndExpression();
      leftNode = AstFactory.createBinary(
        NodeType.LOGICAL_EXPRESSION,
        operatorToken.normalized_token,
        leftNode,
        rightNode
      );
    }

    return leftNode;
  }

  #parseAndExpression() {
    let leftNode = this.#parseNotExpression();

    while (this.#matches("AND")) {
      const operatorToken = this.#consume();
      const rightNode = this.#parseNotExpression();
      leftNode = AstFactory.createBinary(
        NodeType.LOGICAL_EXPRESSION,
        operatorToken.normalized_token,
        leftNode,
        rightNode
      );
    }

    return leftNode;
  }

  #parseNotExpression() {
    if (this.#matches("NOT") && this.#peek(1)?.normalized_token === "EXISTS") {
      const notToken = this.#consume();
      return this.#parseExistsExpression(true, notToken.token_seq);
    }

    if (this.#matches("NOT")) {
      const operatorToken = this.#consume();
      const operandNode = this.#parseNotExpression();
      return AstFactory.createUnary(
        operatorToken.normalized_token,
        operatorToken.token_seq,
        operandNode
      );
    }

    return this.#parseComparisonExpression();
  }

  #parseComparisonExpression() {
    const leftNode = this.#parseConcatenationExpression();

    if (this.#matchesAny(["=", "!=", "<>", "<", "<=", ">", ">="])) {
      const operatorToken = this.#consume();
      const rightNode = this.#parseConcatenationExpression();
      return AstFactory.createBinary(
        NodeType.COMPARISON_EXPRESSION,
        operatorToken.normalized_token,
        leftNode,
        rightNode
      );
    }

    if (this.#matches("IN")) {
      this.#consume();
      return this.#parseInExpression(leftNode, false);
    }

    if (this.#matches("BETWEEN")) {
      this.#consume();
      return this.#parseBetweenExpression(leftNode, false);
    }

    if (this.#matches("IS")) {
      this.#consume();
      return this.#parseIsExpression(leftNode);
    }

    if (this.#matches("NOT")) {
      const markedIndex = this.index;
      this.#consume();

      if (this.#matches("IN")) {
        this.#consume();
        return this.#parseInExpression(leftNode, true);
      }

      if (this.#matches("BETWEEN")) {
        this.#consume();
        return this.#parseBetweenExpression(leftNode, true);
      }

      this.index = markedIndex;
    }

    return leftNode;
  }

  #parseConcatenationExpression() {
    let leftNode = this.#parseAdditiveExpression();

    while (this.#matches("||", false)) {
      const operatorToken = this.#consume();
      const rightNode = this.#parseAdditiveExpression();
      leftNode = AstFactory.createBinary(
        NodeType.CONCATENATION_EXPRESSION,
        operatorToken.token,
        leftNode,
        rightNode
      );
    }

    return leftNode;
  }

  #parseAdditiveExpression() {
    let leftNode = this.#parseMultiplicativeExpression();

    while (this.#matchesAny(["+", "-"], false)) {
      const operatorToken = this.#consume();
      const rightNode = this.#parseMultiplicativeExpression();
      leftNode = AstFactory.createBinary(
        NodeType.ARITHMETIC_EXPRESSION,
        operatorToken.token,
        leftNode,
        rightNode
      );
    }

    return leftNode;
  }

  #parseMultiplicativeExpression() {
    let leftNode = this.#parseUnaryExpression();

    while (this.#matchesAny(["*", "/", "%"], false)) {
      const operatorToken = this.#consume();
      const rightNode = this.#parseUnaryExpression();
      leftNode = AstFactory.createBinary(
        NodeType.ARITHMETIC_EXPRESSION,
        operatorToken.token,
        leftNode,
        rightNode
      );
    }

    return leftNode;
  }

  #parseUnaryExpression() {
    if (this.#matchesAny(["+", "-"], false)) {
      const operatorToken = this.#consume();
      const operandNode = this.#parseUnaryExpression();
      return AstFactory.createUnary(operatorToken.token, operatorToken.token_seq, operandNode);
    }

    return this.#parsePrimaryExpression();
  }

  #parsePrimaryExpression() {
    const token = this.#current();

    if (!token) {
      throw new SyntaxError("ExpressionParser: expression ended unexpectedly.");
    }

    if (token.normalized_token === "CASE") {
      return this.#parseCaseExpression();
    }

    if (token.normalized_token === "EXISTS") {
      return this.#parseExistsExpression(false, token.token_seq);
    }

    if (token.token === "(") {
      return this.#parseParenthesizedExpression();
    }

    if (this.#isLiteralToken(token)) {
      return this.#parseLiteral();
    }

    if (this.#isIdentifierToken(token) || token.token === "*") {
      return this.#parseIdentifierOrFunctionCall();
    }

    throw new SyntaxError(
      `ExpressionParser: token "${token.token}" cannot start an expression ` +
      `(token_seq ${token.token_seq}).`
    );
  }

  #parseCaseExpression() {
    const caseToken = this.#expect("CASE");
    let caseOperand = null;
    const whenClauses = [];
    let elseExpression = null;

    /* CASE直後がWHENでなければ、単純CASEの比較対象を解析する。 */
    if (!this.#matches("WHEN")) {
      caseOperand = this.#parseOrExpression();
    }

    while (this.#matches("WHEN")) {
      const whenToken = this.#consume();
      const conditionNode = this.#parseOrExpression();
      this.#expect("THEN");
      const resultNode = this.#parseOrExpression();
      whenClauses.push(
        AstFactory.createCaseWhen(conditionNode, resultNode, whenToken.token_seq)
      );
    }

    if (whenClauses.length === 0) {
      throw new SyntaxError("ExpressionParser: CASE requires at least one WHEN clause.");
    }

    if (this.#matches("ELSE")) {
      this.#consume();
      elseExpression = this.#parseOrExpression();
    }

    const endToken = this.#expect("END");
    return AstFactory.createCase(
      caseToken,
      caseOperand,
      whenClauses,
      elseExpression,
      endToken
    );
  }

  #parseExistsExpression(negated, startTokenSeq) {
    const existsToken = this.#expect("EXISTS");
    const openToken = this.#expect("(", false);

    if (!this.#matches("SELECT") && !this.#matches("WITH")) {
      throw new SyntaxError("ExpressionParser: EXISTS must contain a subquery.");
    }

    const subqueryNode = this.#parseRawSubquery(openToken);
    return AstFactory.createExists(
      negated ? startTokenSeq : existsToken.token_seq,
      subqueryNode,
      negated
    );
  }

  #parseIdentifierOrFunctionCall() {
    const nameTokens = [];
    const firstToken = this.#consume();
    nameTokens.push(firstToken);

    while (this.#matches(".", false)) {
      const dotToken = this.#consume();
      const nextToken = this.#current();

      if (!nextToken || (!this.#isIdentifierToken(nextToken) && nextToken.token !== "*")) {
        throw new SyntaxError(
          `ExpressionParser: identifier expected after token_seq ${dotToken.token_seq}.`
        );
      }

      nameTokens.push(dotToken);
      nameTokens.push(this.#consume());
    }

    if (this.#matches("(", false)) {
      return this.#parseFunctionCall(nameTokens);
    }

    if (nameTokens.at(-1).token === "*") {
      return AstFactory.createWildcard(nameTokens);
    }

    return AstFactory.createIdentifier(nameTokens);
  }

  #parseFunctionCall(nameTokens) {
    const openToken = this.#expect("(", false);
    const argumentsList = [];

    if (!this.#matches(")", false)) {
      while (true) {
        argumentsList.push(this.#parseOrExpression());

        if (!this.#matches(",", false)) {
          break;
        }

        this.#consume();
      }
    }

    const closeToken = this.#expect(")", false);
    return AstFactory.createFunctionCall(nameTokens, argumentsList, openToken, closeToken);
  }

  #parseParenthesizedExpression() {
    const openToken = this.#expect("(", false);

    if (this.#matches("SELECT") || this.#matches("WITH")) {
      return this.#parseRawSubquery(openToken);
    }

    const expressionNode = this.#parseOrExpression();
    const closeToken = this.#expect(")", false);
    return AstFactory.createParenthesized(expressionNode, openToken, closeToken);
  }

  #parseInExpression(leftNode, negated) {
    const openToken = this.#expect("(", false);

    if (this.#matches("SELECT") || this.#matches("WITH")) {
      return AstFactory.createIn(leftNode, this.#parseRawSubquery(openToken), negated);
    }

    const values = [];

    if (!this.#matches(")", false)) {
      while (true) {
        values.push(this.#parseOrExpression());

        if (!this.#matches(",", false)) {
          break;
        }

        this.#consume();
      }
    }

    const closeToken = this.#expect(")", false);
    const valuesNode = AstFactory.createExpressionList(values, openToken, closeToken);
    return AstFactory.createIn(leftNode, valuesNode, negated);
  }

  #parseBetweenExpression(leftNode, negated) {
    const lowerNode = this.#parseConcatenationExpression();
    this.#expect("AND");
    const upperNode = this.#parseConcatenationExpression();
    return AstFactory.createBetween(leftNode, lowerNode, upperNode, negated);
  }

  #parseIsExpression(leftNode) {
    let negated = false;

    if (this.#matches("NOT")) {
      this.#consume();
      negated = true;
    }

    if (this.#matches("DISTINCT")) {
      this.#consume();
      this.#expect("FROM");
      const rightNode = this.#parseConcatenationExpression();
      return AstFactory.createDistinctFrom(leftNode, rightNode, negated);
    }

    const testToken = this.#current();

    if (!testToken || !["NULL", "TRUE", "FALSE"].includes(testToken.normalized_token)) {
      throw new SyntaxError(
        "ExpressionParser: IS must be followed by NULL, TRUE, FALSE, or [NOT] DISTINCT FROM."
      );
    }

    this.#consume();
    return AstFactory.createIs(leftNode, testToken.normalized_token, negated, testToken.token_seq);
  }

  #parseLiteral() {
    const token = this.#consume();
    let literalType = token.token_type;
    let value = token.token;

    if (["NULL", "TRUE", "FALSE"].includes(token.normalized_token)) {
      literalType = token.normalized_token;
      value = token.normalized_token;
    }

    return AstFactory.createLiteral(token, literalType, value);
  }

  #parseRawSubquery(openToken) {
    const startIndex = this.index;
    let nestedDepth = 0;

    while (!this.#isEnd()) {
      const token = this.#current();

      if (token.token === "(") {
        nestedDepth++;
      } else if (token.token === ")") {
        if (nestedDepth === 0) {
          const closeToken = this.#consume();
          const subqueryTokens = this.tokens.slice(startIndex, this.index - 1);
          const queryAst = this.#buildSubquerySummary(subqueryTokens);
          return AstFactory.createSubquery(openToken, closeToken, subqueryTokens, queryAst);
        }

        nestedDepth--;
      }

      this.#consume();
    }

    throw new SyntaxError(
      `ExpressionParser: subquery beginning at token_seq ${openToken.token_seq} has no closing parenthesis.`
    );
  }

  #buildSubquerySummary(subqueryTokens) {
    /*
     * v2ではQuery全体の完全ASTまでは作らず、既存ClauseParserと
     * SelectParserを再利用して、再帰解析の入口となる概要を保持する。
     */
    try {
      const { ClauseParser } = require("./clause_parser");
      const { SelectParser } = require("./select_parser");
      const clauses = new ClauseParser(subqueryTokens).parse();
      const selectClause = clauses.find((clause) => clause.clause_type === "SELECT");
      const selectItems = selectClause
        ? new SelectParser(subqueryTokens).parse(selectClause)
        : [];

      return { clauses, select_items: selectItems };
    } catch (error) {
      return {
        clauses: [],
        select_items: [],
        parse_error: error.message
      };
    }
  }

  #selectExpressionTokens(startTokenSeq, endTokenSeq) {
    if (startTokenSeq === null && endTokenSeq === null) {
      return this.sourceTokens.slice();
    }

    if (!Number.isInteger(startTokenSeq) || !Number.isInteger(endTokenSeq)) {
      throw new TypeError(
        "ExpressionParser.parseExpression: token sequences must both be integers."
      );
    }

    if (endTokenSeq < startTokenSeq) {
      throw new RangeError(
        "ExpressionParser.parseExpression: endTokenSeq is before startTokenSeq."
      );
    }

    return this.sourceTokens.filter((token) => {
      return token.token_seq >= startTokenSeq && token.token_seq <= endTokenSeq;
    });
  }

  #removeCommentTokens(tokens) {
    return tokens.filter((token) => token.token_type !== "COMMENT");
  }

  #isLiteralToken(token) {
    return token.token_type === "NUMBER" ||
      token.token_type === "STRING" ||
      ["NULL", "TRUE", "FALSE"].includes(token.normalized_token);
  }

  #isIdentifierToken(token) {
    const reserved = [
      "AND", "OR", "NOT", "IN", "BETWEEN", "IS", "NULL", "TRUE", "FALSE",
      "CASE", "WHEN", "THEN", "ELSE", "END", "EXISTS"
    ];

    return token.token_type === "IDENTIFIER" ||
      token.token_type === "BACKTICK_IDENTIFIER" ||
      (token.token_type === "KEYWORD" && !reserved.includes(token.normalized_token));
  }

  #current() {
    return this.tokens[this.index] || null;
  }

  #peek(offset = 0) {
    return this.tokens[this.index + offset] || null;
  }

  #consume() {
    const token = this.#current();
    if (token) this.index++;
    return token;
  }

  #isEnd() {
    return this.index >= this.tokens.length;
  }

  #matches(value, normalized = true) {
    const token = this.#current();
    if (!token) return false;

    const actualValue = normalized ? token.normalized_token : token.token;
    const expectedValue = normalized ? String(value).toUpperCase() : String(value);
    return actualValue === expectedValue;
  }

  #matchesAny(values, normalized = true) {
    return values.some((value) => this.#matches(value, normalized));
  }

  #expect(value, normalized = true) {
    if (!this.#matches(value, normalized)) {
      const token = this.#current();
      const actualValue = token ? token.token : "EOF";
      throw new SyntaxError(
        `ExpressionParser: expected "${value}", but found "${actualValue}".`
      );
    }

    return this.#consume();
  }
}

module.exports = { ExpressionParser, NodeType };
