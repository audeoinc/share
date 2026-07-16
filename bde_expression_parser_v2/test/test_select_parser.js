"use strict";

const { tokenize } = require("../src/lexer");
const { ClauseParser } = require("../src/clause_parser");
const { SelectParser } = require("../src/select_parser");

const sql = `
SELECT DISTINCT
  customer_id,
  SUM(IF(amount > 0, amount, 0)) AS total_amount,
  price * quantity total_price,
  customer.*,
  a + b,
  CASE WHEN status = 'A' THEN amount ELSE 0 END adjusted_amount
FROM sales AS customer;
`;

const tokens = tokenize(sql);
const clauseParser = new ClauseParser(tokens);
const clauses = clauseParser.parse();
const selectClause = clauses.find((clause) => clause.clause_type === "SELECT");

if (!selectClause) {
  throw new Error("SELECT Clause was not found.");
}

const selectParser = new SelectParser(tokens);
const selectItems = selectParser.parse(selectClause);

console.log("\n===== SELECT項目 =====");
console.table(selectItems);

const expected = [
  {
    output_alias: "CUSTOMER_ID",
    alias_type: "DERIVED_COLUMN",
    wildcard_type: null
  },
  {
    output_alias: "TOTAL_AMOUNT",
    alias_type: "EXPLICIT_AS",
    wildcard_type: null
  },
  {
    output_alias: "TOTAL_PRICE",
    alias_type: "IMPLICIT",
    wildcard_type: null
  },
  {
    output_alias: null,
    alias_type: "NONE",
    wildcard_type: "QUALIFIED"
  },
  {
    output_alias: null,
    alias_type: "NONE",
    wildcard_type: null
  },
  {
    output_alias: "ADJUSTED_AMOUNT",
    alias_type: "IMPLICIT",
    wildcard_type: null
  }
];

for (let itemIndex = 0; itemIndex < expected.length; itemIndex++) {
  const actualItem = selectItems[itemIndex];
  const expectedItem = expected[itemIndex];

  for (const propertyName of Object.keys(expectedItem)) {
    if (actualItem[propertyName] !== expectedItem[propertyName]) {
      throw new Error(
        `SELECT item ${itemIndex + 1}: ${propertyName} mismatch. ` +
        `Expected ${String(expectedItem[propertyName])}, ` +
        `received ${String(actualItem[propertyName])}.`
      );
    }
  }
}

if (selectItems.length !== expected.length) {
  throw new Error(
    `Expected ${expected.length} SELECT items, received ${selectItems.length}.`
  );
}

console.log("\nSelect Parser test passed.");
