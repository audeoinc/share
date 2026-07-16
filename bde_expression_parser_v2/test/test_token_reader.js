"use strict";

const { tokenize } = require("../src/lexer");
const { TokenReader } = require("../src/token_reader");

const sql = `
SELECT
  customer_id,
  SUM(IF(amount > 0, amount, 0)) AS total_amount
FROM sales;
`;

const tokens = tokenize(sql);
const reader = new TokenReader(tokens);

console.table(tokens);

const sumToken = reader.findForward("SUM");

if (!sumToken) {
  throw new Error("SUM Token was not found.");
}

const openParenthesis = reader.findForward("(", {
  startTokenSeq: sumToken.token_seq,
  normalized: false
});

if (!openParenthesis) {
  throw new Error("Opening parenthesis was not found.");
}

const closeParenthesis = reader.findMatchingCloseParenthesis(
  openParenthesis.token_seq
);

if (!closeParenthesis) {
  throw new Error("Closing parenthesis was not found.");
}

const sumExpression = reader.sliceByTokenSeq(
  sumToken.token_seq,
  closeParenthesis.token_seq
);

console.table(sumExpression);
