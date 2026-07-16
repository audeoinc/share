"use strict";

const { tokenize } = require("../src/lexer");
const { ClauseParser } = require("../src/clause_parser");

const sql = `
SELECT
  customer_id,
  SUM(IF(amount > 0, amount, 0)) AS total_amount
FROM sales
WHERE amount > 0
GROUP
-- GROUPとBYの間のコメント
BY customer_id
HAVING SUM(amount) > 100
QUALIFY ROW_NUMBER() OVER (
  PARTITION BY customer_id
  ORDER BY total_amount DESC
) = 1
ORDER BY total_amount DESC
LIMIT 100;
`;

const tokens = tokenize(sql);
const parser = new ClauseParser(tokens);
const clauses = parser.parse();

console.log("\n===== Clause一覧 =====");
console.table(clauses);

const expectedClauseTypes = [
  "SELECT",
  "FROM",
  "WHERE",
  "GROUP_BY",
  "HAVING",
  "QUALIFY",
  "ORDER_BY",
  "LIMIT"
];

const actualClauseTypes = clauses.map((clause) => clause.clause_type);

if (JSON.stringify(actualClauseTypes) !== JSON.stringify(expectedClauseTypes)) {
  throw new Error(
    `Clause types did not match.\n` +
    `Expected: ${JSON.stringify(expectedClauseTypes)}\n` +
    `Actual:   ${JSON.stringify(actualClauseTypes)}`
  );
}

console.log("\nClause Parser test passed.");
